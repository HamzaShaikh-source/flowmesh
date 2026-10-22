"""A small, hardened MCP client: stdio and streamable-HTTP transports.

FlowMesh uses MCP servers as its hands: messaging, code, files, browsers. This module
only *speaks the protocol*. Whether a call is allowed to happen at all is decided
elsewhere (mcp_registry.py: registration, risk levels, schema checks, and the one
approval a person gives to a plan that names the exact call).

What this module guarantees, in code rather than in prose:

1. **No shell.** A stdio server is started from an argument list with `shell=False`.
2. **A minimal environment.** The child gets a short allow-list of variables plus the
   ones the person configured for that server. FlowMesh's own secrets (Home Assistant
   token, model keys, Wispr tokens) are never inherited.
3. **Server requests are refused, not obeyed.** MCP lets a server ask the client for
   sampling, roots or elicitation. FlowMesh answers `ping` and declines everything
   else, so a server cannot make FlowMesh call a model or read files on its behalf.
4. **Bounded.** Every request has a timeout, every line and body a size cap, and tool
   output is truncated and stripped of control characters before anyone sees it.
5. **Cleanup.** A stdio child is terminated (then killed) when its session closes.
6. **HTTP is HTTPS** (loopback HTTP allowed), redirects are never followed, and the
   response is never trusted to be well-formed.

Tool output is data from a third party. Nothing here interprets it.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

from flowmesh_config import VERSION

PROTOCOL = "2025-06-18"
MAX_LINE = 2_000_000
MAX_BODY = 4_000_000
MAX_OUTPUT_CHARS = 20_000
MAX_TOOL_PAGES = 10
LIST_TIMEOUT = 20.0
CALL_TIMEOUT = 60.0
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# `.cmd`/`.bat` shims (npx.cmd) run through cmd.exe, which re-parses these characters.
BATCH_UNSAFE = re.compile(r'[&|<>^%!"\r\n]')

# Variables a server genuinely needs to start (npx, uvx, python, node). Everything else
# FlowMesh's own process holds is withheld unless the person set it for that server.
SAFE_ENV = (
    "PATH", "PATHEXT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT",
    "SYSTEMDRIVE", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "SHELL", "USER",
    "USERNAME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "NVM_DIR",
    "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "NODE_EXTRA_CA_CERTS",
)


class McpError(Exception):
    """`kind` is stable for the UI and tests; `message` is a plain sentence."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - urllib hook
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def clean_output(value: object, limit: int = MAX_OUTPUT_CHARS) -> str:
    """Untrusted text: no control characters (keeps newline and tab), bounded."""
    if not isinstance(value, str):
        return ""
    return _CONTROL.sub(" ", value)[:limit]


def child_environment(extra: dict[str, str] | None = None, base: dict[str, str] | None = None) -> dict[str, str]:
    source = os.environ if base is None else base
    env = {name: source[name] for name in SAFE_ENV if name in source}
    env.update({str(k): str(v) for k, v in (extra or {}).items()})
    return env


def resolve_command(command: str) -> str | None:
    """Find the executable without a shell. On Windows this finds `npx.cmd` and friends."""
    if not command or any(ch in command for ch in "\x00\r\n"):
        return None
    return shutil.which(command)


# ---------------------------------------------------------------- stdio transport


class StdioTransport:
    """Newline-delimited JSON-RPC over a child process's stdin/stdout."""

    kind = "stdio"

    def __init__(self, command: str, args: list[str], env: dict[str, str] | None = None, cwd: str | None = None):
        self._command, self._args, self._env, self._cwd = command, list(args), dict(env or {}), cwd
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._pending: dict[int, dict] = {}
        self._counter = 0
        self._stderr_tail = ""
        self.tools_dirty = False
        self.closed = False

    # -- lifecycle

    def start(self) -> None:
        executable = resolve_command(self._command)
        if executable is None:
            raise McpError("unavailable", f"Could not find '{self._command}' on this computer.")
        if os.name == "nt" and executable.lower().endswith((".cmd", ".bat")):
            if BATCH_UNSAFE.search(executable) or any(BATCH_UNSAFE.search(a) for a in self._args):
                raise McpError("bad_config", "This server is started through cmd.exe, which cannot safely take arguments containing & | < > ^ % ! or quotes.")
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            self._proc = subprocess.Popen(
                [executable, *self._args], shell=False, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, env=child_environment(self._env), cwd=self._cwd or None,
                creationflags=flags,
            )
        except (OSError, ValueError) as exc:
            raise McpError("unavailable", f"Could not start the server ({type(exc).__name__}).")
        self._threads = [threading.Thread(target=self._read_stdout, daemon=True),
                         threading.Thread(target=self._drain_stderr, daemon=True)]
        for thread in self._threads:
            thread.start()

    def close(self) -> None:
        self.closed = True
        proc = self._proc
        if proc is None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=1.5)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
        # The readers see EOF once the child is gone; only then is it safe to close the
        # pipes, otherwise every closed session would leak two file handles.
        for thread in getattr(self, "_threads", []):
            thread.join(timeout=2)
        for pipe in (proc.stdout, proc.stderr):
            try:
                if pipe:
                    pipe.close()
            except OSError:
                pass
        self._fail_all(McpError("unavailable", "The server was closed."))

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None and not self.closed

    # -- io

    def _send(self, message: dict) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.poll() is not None:
            raise McpError("unavailable", "The server is not running.")
        data = (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
        try:
            with self._lock:
                proc.stdin.write(data)
                proc.stdin.flush()
        except (OSError, ValueError):
            raise McpError("unavailable", "The server stopped accepting input.")

    def _read_stdout(self) -> None:
        proc = self._proc
        assert proc is not None and proc.stdout is not None
        try:
            for raw in iter(lambda: proc.stdout.readline(MAX_LINE + 1), b""):
                if len(raw) > MAX_LINE:
                    continue
                try:
                    message = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue  # servers sometimes log to stdout; ignore non-JSON lines
                if isinstance(message, dict):
                    self._dispatch(message)
        except (OSError, ValueError):
            pass
        finally:
            tail = self._stderr_tail.strip().splitlines()[-1:] or [""]
            self._fail_all(McpError("unavailable", "The server exited." + (f" Last output: {clean_output(tail[0], 160)}" if tail[0] else "")))

    def _drain_stderr(self) -> None:
        proc = self._proc
        assert proc is not None and proc.stderr is not None
        try:
            for raw in iter(lambda: proc.stderr.readline(4096), b""):
                self._stderr_tail = (self._stderr_tail + raw.decode("utf-8", "replace"))[-2000:]
        except (OSError, ValueError):
            pass

    def _dispatch(self, message: dict) -> None:
        method, mid = message.get("method"), message.get("id")
        if method is not None and mid is not None:
            # A request *from* the server. Answer ping; refuse everything else.
            if method == "ping":
                self._reply(mid, result={})
            else:
                self._reply(mid, error={"code": -32601, "message": "FlowMesh does not support server-initiated requests."})
            return
        if method == "notifications/tools/list_changed":
            self.tools_dirty = True
            return
        if method is not None:
            return
        with self._lock:
            slot = self._pending.get(mid) if isinstance(mid, int) else None
        if slot is not None:
            slot["message"] = message
            slot["event"].set()

    def _reply(self, mid: object, result: dict | None = None, error: dict | None = None) -> None:
        body: dict = {"jsonrpc": "2.0", "id": mid}
        body.update({"error": error} if error else {"result": result or {}})
        try:
            self._send(body)
        except McpError:
            pass

    def _fail_all(self, error: McpError) -> None:
        with self._lock:
            slots = list(self._pending.values())
        for slot in slots:
            slot.setdefault("error", error)
            slot["event"].set()

    # -- protocol

    def request(self, method: str, params: dict, timeout: float) -> dict:
        with self._lock:
            self._counter += 1
            mid = self._counter
            slot = {"event": threading.Event()}
            self._pending[mid] = slot
        try:
            self._send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
            if not slot["event"].wait(timeout):
                raise McpError("timeout", f"The server did not answer {method} within {int(timeout)} seconds.")
            if "error" in slot and "message" not in slot:
                raise slot["error"]
            return _result_of(slot["message"])
        finally:
            with self._lock:
                self._pending.pop(mid, None)

    def notify(self, method: str, params: dict) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})


# ---------------------------------------------------------------- HTTP transport


class HttpTransport:
    """MCP streamable HTTP: one POST per message, JSON or SSE back."""

    kind = "http"

    def __init__(self, url: str, headers: dict[str, str] | None = None, allow_loopback_http: bool = True):
        parsed = urlparse(url)
        loopback = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        ok = parsed.scheme == "https" or (parsed.scheme == "http" and loopback and allow_loopback_http)
        if not ok or not parsed.hostname or parsed.username or parsed.password:
            raise McpError("bad_config", "An HTTP MCP server must use https:// (http:// only for localhost) and no embedded credentials.")
        self._url = url
        self._headers = {str(k): str(v) for k, v in (headers or {}).items()}
        self._session: str | None = None
        self._counter = 0
        self._lock = threading.Lock()
        self.tools_dirty = False
        self.closed = False
        self.protocol = PROTOCOL

    def start(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True

    @property
    def alive(self) -> bool:
        return not self.closed

    def _post(self, message: dict, timeout: float):
        headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
                   "MCP-Protocol-Version": self.protocol, "User-Agent": f"FlowMesh/{VERSION}", **self._headers}
        if self._session:
            headers["Mcp-Session-Id"] = self._session
        request = urllib.request.Request(self._url, data=json.dumps(message).encode(), method="POST", headers=headers)
        try:
            with _OPENER.open(request, timeout=timeout) as response:
                return response.status, response.headers, response.read(MAX_BODY + 1)[:MAX_BODY]
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, exc.read(MAX_BODY)
        except (urllib.error.URLError, OSError, TimeoutError):
            raise McpError("unavailable", "Could not reach the MCP server.")

    def request(self, method: str, params: dict, timeout: float) -> dict:
        with self._lock:
            self._counter += 1
            mid = self._counter
        status, headers, body = self._post({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}, timeout)
        if status == 401:
            raise McpError("auth", "The server rejected the credentials (401). Check the token for this server.")
        if status == 403:
            raise McpError("auth", "The server refused access (403).")
        if status == 429:
            raise McpError("rate_limited", "The server asked FlowMesh to slow down.")
        if status != 200:
            raise McpError("unavailable", f"The server answered HTTP {status}.")
        if headers.get("mcp-session-id"):
            self._session = headers.get("mcp-session-id")
        return _result_of(_find_answer(headers.get("content-type", ""), body, mid))

    def notify(self, method: str, params: dict) -> None:
        status, _, _ = self._post({"jsonrpc": "2.0", "method": method, "params": params}, LIST_TIMEOUT)
        if status not in (200, 202):
            raise McpError("unavailable", f"The server answered HTTP {status}.")


def _find_answer(content_type: str, body: bytes, request_id: int) -> dict:
    text = body.decode("utf-8", "replace")
    messages: list[object] = []
    if "text/event-stream" in content_type:
        for event in text.replace("\r\n", "\n").split("\n\n"):
            data = "\n".join(line[5:].lstrip() for line in event.split("\n") if line.startswith("data:"))
            if data:
                try:
                    messages.append(json.loads(data))
                except ValueError:
                    continue
    else:
        try:
            messages.append(json.loads(text))
        except ValueError:
            pass
    for message in messages:
        if isinstance(message, dict) and message.get("id") == request_id:
            return message
    raise McpError("bad_response", "The server sent an answer FlowMesh could not read.")


def _result_of(message: dict) -> dict:
    if "error" in message:
        error = message["error"] if isinstance(message["error"], dict) else {}
        raise McpError("server_error", clean_output(str(error.get("message") or "The server reported an error."), 300))
    result = message.get("result")
    if not isinstance(result, dict):
        raise McpError("bad_response", "The server sent an unexpected answer.")
    return result


# ---------------------------------------------------------------- session


def normalize_result(result: dict) -> dict:
    """Reduce a tools/call result to text FlowMesh can show, never raw blobs."""
    parts, texts = [], []
    for part in result.get("content") or []:
        if not isinstance(part, dict):
            continue
        kind = str(part.get("type") or "unknown")
        parts.append(kind)
        if kind == "text":
            texts.append(clean_output(part.get("text") or ""))
        elif kind in {"image", "audio"}:
            size = len(part.get("data") or "") * 3 // 4
            texts.append(f"[{kind} {part.get('mimeType', '')}, about {size} bytes, not displayed]")
        elif kind == "resource_link":
            texts.append(f"[resource link: {clean_output(str(part.get('uri') or ''), 300)}]")
        elif kind == "resource":
            res = part.get("resource") if isinstance(part.get("resource"), dict) else {}
            texts.append(clean_output(res.get("text") or f"[embedded resource {clean_output(str(res.get('uri') or ''), 200)}]"))
    text = "\n".join(t for t in texts if t)
    structured = result.get("structuredContent")
    if not text and structured is not None:
        try:
            text = clean_output(json.dumps(structured, indent=2))
        except (TypeError, ValueError):
            text = ""
    truncated = len(text) >= MAX_OUTPUT_CHARS
    return {"is_error": bool(result.get("isError")), "text": text[:MAX_OUTPUT_CHARS], "parts": parts, "truncated": truncated}


class McpSession:
    def __init__(self, transport, label: str = ""):
        self.transport = transport
        self.label = label
        self.server_info: dict = {}
        self.tools_cache: tuple[float, list[dict]] | None = None

    def open(self) -> "McpSession":
        self.transport.start()
        try:
            result = self.transport.request("initialize", {
                "protocolVersion": PROTOCOL, "capabilities": {},
                "clientInfo": {"name": "flowmesh", "version": VERSION},
            }, LIST_TIMEOUT)
            version = result.get("protocolVersion")
            if hasattr(self.transport, "protocol") and isinstance(version, str):
                self.transport.protocol = version
            info = result.get("serverInfo")
            self.server_info = {k: clean_output(str(v), 80) for k, v in (info or {}).items() if k in {"name", "version", "title"}}
            self.transport.notify("notifications/initialized", {})
        except Exception:
            self.transport.close()
            raise
        return self

    def close(self) -> None:
        self.transport.close()

    @property
    def alive(self) -> bool:
        return self.transport.alive

    def list_tools(self, force: bool = False, ttl: float = 300.0) -> list[dict]:
        if (not force and not self.transport.tools_dirty and self.tools_cache
                and time.monotonic() - self.tools_cache[0] < ttl):
            return self.tools_cache[1]
        tools, cursor = [], None
        for _ in range(MAX_TOOL_PAGES):
            result = self.transport.request("tools/list", {"cursor": cursor} if cursor else {}, LIST_TIMEOUT)
            tools += [t for t in result.get("tools") or [] if isinstance(t, dict) and isinstance(t.get("name"), str)]
            cursor = result.get("nextCursor")
            if not isinstance(cursor, str) or not cursor:
                break
        self.transport.tools_dirty = False
        self.tools_cache = (time.monotonic(), tools)
        return tools

    def call_tool(self, name: str, arguments: dict, timeout: float = CALL_TIMEOUT) -> dict:
        result = self.transport.request("tools/call", {"name": name, "arguments": arguments}, timeout)
        return normalize_result(result)
