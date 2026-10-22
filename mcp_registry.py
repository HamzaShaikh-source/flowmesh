"""Which MCP servers FlowMesh may use, what their tools are, and how risky each call is.

This is the policy layer between "a tool exists" and "a person approved this exact
call". It is deliberately conservative:

* **Risk is derived by FlowMesh, never trusted from the server.** A tool is `danger`
  if it says so (`destructiveHint`) or its *name* looks destructive, `read` only if it
  claims `readOnlyHint` **and** its name is not destructive, otherwise `write`.
  Annotations are hints from a third party: they can raise risk, and they can lower
  it only as far as `read`, which still needs the person's per-server opt-in
  (`auto_read`) before anything runs without a click.
* **Arguments are checked against the tool's own JSON schema** before a plan exists,
  so a plan never contains a call the server would reject for shape, and the model that
  proposes arguments can never smuggle an unknown field past `additionalProperties`.
* **Credentials never leave in a response.** Environment values and HTTP headers are
  stored in the credential blob and echoed back masked.
"""

from __future__ import annotations

import json
import re
import threading
import time

import flowmesh_config
import mcp_client
from mcp_client import HttpTransport, McpError, McpSession, StdioTransport, clean_output

BLOB = "mcp_servers"
MASK = "********"
MAX_SERVERS = 20
MAX_ARGS_BYTES = 32_000
MAX_TOOLS_PER_SERVER = 200
IDLE_SECONDS = 15 * 60
SERVER_ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}")
ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
HEADER_NAME = re.compile(r"[A-Za-z0-9-]{1,64}")
DANGER_NAME = re.compile(
    r"(^|[_\-. ])(delete|remove|drop|destroy|purge|wipe|erase|kill|terminate|revoke|reset|force|exec|execute|shell|run_command|rm)([_\-. ]|$)",
    re.IGNORECASE,
)

READ, WRITE, DANGER = "read", "write", "danger"


# ---------------------------------------------------------------- risk


def classify(tool: dict) -> str:
    annotations = tool.get("annotations") if isinstance(tool.get("annotations"), dict) else {}
    name = str(tool.get("name") or "")
    if annotations.get("destructiveHint") is True or DANGER_NAME.search(name):
        return DANGER
    if annotations.get("readOnlyHint") is True:
        return READ
    return WRITE


# ---------------------------------------------------------------- JSON-schema subset

_TYPE_CHECKS = {
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "null": lambda v: v is None,
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
}


def validate_arguments(schema: object, value: object, path: str = "arguments", depth: int = 0) -> list[str]:
    """Errors for `value` against the commonly used subset of JSON Schema.

    Unknown keywords and `$ref` are ignored (the server stays authoritative); what is
    checked is exactly what a person or a model is most likely to get wrong: type,
    required, enum, bounds, array items, and `additionalProperties: false`.
    """
    if not isinstance(schema, dict) or depth > 8:
        return []
    for key in ("anyOf", "oneOf"):
        options = schema.get(key)
        if isinstance(options, list) and options:
            if not any(not validate_arguments(option, value, path, depth + 1) for option in options):
                return [f"{path} matches none of the allowed shapes"]
    errors: list[str] = []
    expected = schema.get("type")
    kinds = expected if isinstance(expected, list) else [expected] if isinstance(expected, str) else []
    if kinds and not any(_TYPE_CHECKS.get(kind, lambda _v: True)(value) for kind in kinds):
        return [f"{path} must be {' or '.join(kinds)}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path} must equal {json.dumps(schema['const'])}")
    if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
        errors.append(f"{path} must be one of {json.dumps(schema['enum'])[:120]}")
    if isinstance(value, str):
        if isinstance(schema.get("minLength"), int) and len(value) < schema["minLength"]:
            errors.append(f"{path} is shorter than {schema['minLength']}")
        if isinstance(schema.get("maxLength"), int) and len(value) > schema["maxLength"]:
            errors.append(f"{path} is longer than {schema['maxLength']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(schema.get("minimum"), (int, float)) and value < schema["minimum"]:
            errors.append(f"{path} is below {schema['minimum']}")
        if isinstance(schema.get("maximum"), (int, float)) and value > schema["maximum"]:
            errors.append(f"{path} is above {schema['maximum']}")
    if isinstance(value, list):
        if isinstance(schema.get("minItems"), int) and len(value) < schema["minItems"]:
            errors.append(f"{path} needs at least {schema['minItems']} items")
        if isinstance(schema.get("maxItems"), int) and len(value) > schema["maxItems"]:
            errors.append(f"{path} allows at most {schema['maxItems']} items")
        for index, item in enumerate(value[:100]):
            errors += validate_arguments(schema.get("items"), item, f"{path}[{index}]", depth + 1)
    if isinstance(value, dict):
        properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
        for name in schema.get("required") or []:
            if name not in value:
                errors.append(f"{path}.{name} is required")
        if schema.get("additionalProperties") is False:
            for name in value:
                if name not in properties:
                    errors.append(f"{path}.{name} is not an accepted field")
        for name, item in value.items():
            if name in properties:
                errors += validate_arguments(properties[name], item, f"{path}.{name}", depth + 1)
    return errors[:12]


# ---------------------------------------------------------------- server config


def validate_server(raw: object, existing: dict | None = None) -> dict:
    """A clean server record, or ValueError with a sentence for the person."""
    if not isinstance(raw, dict):
        raise ValueError("Server must be an object")
    existing = existing or {}
    server_id = raw.get("id")
    if not isinstance(server_id, str) or not SERVER_ID.fullmatch(server_id):
        raise ValueError("Server id must be lowercase letters, digits, '-' or '_' (max 32)")
    label = raw.get("label") if isinstance(raw.get("label"), str) else server_id
    transport = raw.get("transport")
    if transport not in {"stdio", "http"}:
        raise ValueError("Transport must be 'stdio' or 'http'")
    clean: dict = {"id": server_id, "label": label.strip()[:60] or server_id, "transport": transport,
                   "enabled": raw.get("enabled", True) is True, "auto_read": raw.get("auto_read", False) is True}
    if transport == "stdio":
        command = raw.get("command")
        if not isinstance(command, str) or not command.strip() or len(command) > 256 or any(c in command for c in "\r\n\x00"):
            raise ValueError("A stdio server needs a command (a program name or path, no arguments)")
        args = raw.get("args", [])
        if not isinstance(args, list) or len(args) > 32 or any(not isinstance(a, str) or len(a) > 1024 or "\x00" in a for a in args):
            raise ValueError("Arguments must be up to 32 short strings")
        clean.update({"command": command.strip(), "args": list(args),
                      "env": _secret_map(raw.get("env"), existing.get("env"), ENV_NAME, "Environment variable", 20)})
        cwd = raw.get("cwd")
        if cwd not in (None, ""):
            if not isinstance(cwd, str) or len(cwd) > 512 or "\x00" in cwd:
                raise ValueError("Working directory is invalid")
            clean["cwd"] = cwd
    else:
        url = raw.get("url")
        if not isinstance(url, str):
            raise ValueError("An HTTP server needs a url")
        try:
            HttpTransport(url)
        except McpError as exc:
            raise ValueError(exc.message)
        clean.update({"url": url.strip(),
                      "headers": _secret_map(raw.get("headers"), existing.get("headers"), HEADER_NAME, "Header", 10)})
    return clean


def _secret_map(raw: object, current: object, name_pattern: re.Pattern, noun: str, limit: int) -> dict[str, str]:
    if raw in (None, ""):
        return {}
    if not isinstance(raw, dict) or len(raw) > limit:
        raise ValueError(f"{noun}s must be an object with at most {limit} entries")
    kept = current if isinstance(current, dict) else {}
    out = {}
    for name, value in raw.items():
        if not isinstance(name, str) or not name_pattern.fullmatch(name):
            raise ValueError(f"{noun} name '{str(name)[:30]}' is invalid")
        if not isinstance(value, str) or len(value) > 4096 or any(c in value for c in "\r\n\x00"):
            raise ValueError(f"{noun} {name} has an invalid value")
        out[name] = kept.get(name, "") if value == MASK else value
    return out


def public_server(server: dict) -> dict:
    """What the UI may see: shape and names of secrets, never their values."""
    out = {k: v for k, v in server.items() if k not in {"env", "headers"}}
    for key in ("env", "headers"):
        if key in server:
            out[key] = {name: MASK for name in server[key]}
    return out


def public_tool(server_id: str, tool: dict) -> dict:
    schema = tool.get("inputSchema")
    try:
        too_big = len(json.dumps(schema)) > 20_000
    except (TypeError, ValueError):
        too_big = True
    return {
        "server": server_id,
        "name": tool["name"],
        "title": clean_output(str(tool.get("title") or tool["name"]), 100),
        "description": " ".join(clean_output(str(tool.get("description") or ""), 600).split()),
        "risk": classify(tool),
        "input_schema": {} if too_big or not isinstance(schema, dict) else schema,
    }


# ---------------------------------------------------------------- manager


class McpManager:
    def __init__(self, load=None, save=None):
        self._load = load or (lambda: flowmesh_config.load_blob(BLOB))
        self._save = save or (lambda value: flowmesh_config.save_blob(BLOB, value))
        self._lock = threading.RLock()
        self._sessions: dict[str, McpSession] = {}
        self._used: dict[str, float] = {}
        self._connect_locks: dict[str, threading.Lock] = {}

    # -- registry

    def _servers(self) -> list[dict]:
        servers = self._load().get("servers")
        return [s for s in servers if isinstance(s, dict)] if isinstance(servers, list) else []

    def list_servers(self) -> list[dict]:
        with self._lock:
            return [{**public_server(s), "connected": s["id"] in self._sessions and self._sessions[s["id"]].alive}
                    for s in self._servers()]

    def get(self, server_id: str) -> dict | None:
        return next((s for s in self._servers() if s["id"] == server_id), None)

    def upsert(self, raw: object) -> dict:
        with self._lock:
            servers = self._servers()
            current = self.get(raw.get("id")) if isinstance(raw, dict) else None
            clean = validate_server(raw, current)
            if current is None and len(servers) >= MAX_SERVERS:
                raise ValueError(f"At most {MAX_SERVERS} servers")
            self._close(clean["id"])
            self._save({"servers": [s for s in servers if s["id"] != clean["id"]] + [clean]})
            return public_server(clean)

    def remove(self, server_id: str) -> bool:
        with self._lock:
            servers = self._servers()
            kept = [s for s in servers if s["id"] != server_id]
            self._close(server_id)
            if len(kept) == len(servers):
                return False
            self._save({"servers": kept})
            return True

    # -- sessions

    def _close(self, server_id: str) -> None:
        session = self._sessions.pop(server_id, None)
        self._used.pop(server_id, None)
        if session is not None:
            session.close()

    def close_all(self) -> None:
        with self._lock:
            for server_id in list(self._sessions):
                self._close(server_id)

    def _reap(self) -> None:
        now = time.monotonic()
        for server_id, last in list(self._used.items()):
            if now - last > IDLE_SECONDS or not self._sessions[server_id].alive:
                self._close(server_id)

    def _session(self, server_id: str) -> McpSession:
        with self._lock:
            self._reap()
            server = self.get(server_id)
            if server is None:
                raise McpError("unknown_server", "That server is not registered.")
            if not server.get("enabled"):
                raise McpError("disabled", "That server is switched off.")
            existing = self._sessions.get(server_id)
            if existing is not None and existing.alive:
                self._used[server_id] = time.monotonic()
                return existing
            gate = self._connect_locks.setdefault(server_id, threading.Lock())
        with gate:  # one connection attempt per server at a time, without blocking others
            with self._lock:
                existing = self._sessions.get(server_id)
                if existing is not None and existing.alive:
                    return existing
            if server["transport"] == "stdio":
                transport = StdioTransport(server["command"], server.get("args", []), server.get("env"), server.get("cwd"))
            else:
                transport = HttpTransport(server["url"], server.get("headers"))
            session = McpSession(transport, server["label"]).open()
            with self._lock:
                self._sessions[server_id] = session
                self._used[server_id] = time.monotonic()
            return session

    # -- tools

    def tools(self, server_id: str, force: bool = False) -> list[dict]:
        session = self._session(server_id)
        listed = session.list_tools(force=force)[:MAX_TOOLS_PER_SERVER]
        return [public_tool(server_id, tool) for tool in listed]

    def catalog(self) -> dict:
        tools: list[dict] = []
        errors: dict[str, str] = {}
        for server in self._servers():
            if not server.get("enabled"):
                continue
            try:
                tools += self.tools(server["id"])
            except McpError as exc:
                errors[server["id"]] = exc.message
        return {"tools": tools, "errors": errors}

    def test(self, server_id: str) -> dict:
        self._close(server_id)
        session = self._session(server_id)
        tools = session.list_tools(force=True)
        return {"ok": True, "server_info": session.server_info, "tools": len(tools)}

    def call(self, server_id: str, tool: str, arguments: dict, timeout: float = mcp_client.CALL_TIMEOUT) -> dict:
        return self._session(server_id).call_tool(tool, arguments, timeout)

    # -- planning

    def plan_actions(self, raw_calls: object) -> list[dict]:
        """Validate proposed calls (from a person or a model) into reviewable actions."""
        if not isinstance(raw_calls, list) or not 1 <= len(raw_calls) <= 8:
            raise ValueError("A tool plan needs between 1 and 8 calls")
        actions = []
        listed: dict[str, dict[str, dict]] = {}
        for index, call in enumerate(raw_calls, start=1):
            if not isinstance(call, dict) or set(call) - {"server", "tool", "arguments"}:
                raise ValueError(f"Call {index} must have only server, tool and arguments")
            server_id, name, arguments = call.get("server"), call.get("tool"), call.get("arguments", {})
            if not isinstance(server_id, str) or not isinstance(name, str) or not isinstance(arguments, dict):
                raise ValueError(f"Call {index} is malformed")
            server = self.get(server_id)
            if server is None or not server.get("enabled"):
                raise ValueError(f"Call {index}: server '{server_id[:32]}' is not available")
            if server_id not in listed:
                try:
                    listed[server_id] = {t["name"]: t for t in self.tools(server_id)}
                except McpError as exc:
                    raise ValueError(f"Call {index}: {exc.message}")
            tool = listed[server_id].get(name)
            if tool is None:
                raise ValueError(f"Call {index}: server '{server_id}' has no tool '{name[:60]}'")
            if len(json.dumps(arguments)) > MAX_ARGS_BYTES:
                raise ValueError(f"Call {index}: arguments are too large")
            errors = validate_arguments(tool["input_schema"], arguments)
            if errors:
                raise ValueError(f"Call {index} ({name}): " + "; ".join(errors[:4]))
            risk = tool["risk"]
            actions.append({
                "kind": "mcp_call", "target": f"{server_id}/{name}", "label": tool["title"],
                "detail": summarize_arguments(arguments), "surface": "tools",
                "server": server_id, "server_label": server["label"], "tool": name, "risk": risk,
                "arguments": arguments, "auto_ok": risk == READ and bool(server.get("auto_read")),
            })
        return actions


def summarize_arguments(arguments: dict) -> str:
    if not arguments:
        return "no arguments"
    parts = []
    for key, value in list(arguments.items())[:4]:
        text = value if isinstance(value, str) else json.dumps(value)
        text = " ".join(str(text).split())
        parts.append(f"{key}: {text[:60]}{'…' if len(text) > 60 else ''}")
    more = f" (+{len(arguments) - 4} more)" if len(arguments) > 4 else ""
    return "; ".join(parts) + more


MANAGER = McpManager()
