"""Connect a Wispr Flow account through Wispr's own, supported interface.

Why this file exists
--------------------
`wispr_source.py` reads Wispr's local history database. That works, but Wispr does
not document that file as an integration point. Wispr *does* publish a remote MCP
server (`https://api.wisprflow.ai/connect/mcp`) protected by OAuth, whose tools expose
the user's Scratchpad notes. This module is the sanctioned path: the user signs in
on Wispr's own page, FlowMesh holds a refresh token, and notes arrive over HTTPS.

Hard rules, each enforced below rather than promised:

1. **Device flow only.** The user types a short code on Wispr's page; FlowMesh never
   sees a password and needs no redirect listener.
2. **Public client, no secret.** PKCE-less device grant, `token_endpoint_auth_method`
   is `none`; nothing sensitive is embedded in the shipped app.
3. **Allow-listed tools.** Only the Scratchpad note tools are ever called. Anything
   whose name mentions dictation, history or transcripts is refused by name.
4. **Wispr's text is untrusted.** It is stripped of control characters, length-capped,
   and only ever placed in the command box for the user to read. It is never planned
   or executed without the normal plan-approve-run step.
5. **Tokens never leave this module.** Callers get state and note text, never a token,
   device code or client id.
6. **No redirects, HTTPS only** (loopback HTTP is accepted solely for tests), and
   every endpoint named by discovery must sit on the issuer's own host.

Not verified against a live account until the owner signs in once; see
docs/WISPR-CONNECTOR.md for exactly what was and was not exercised.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlparse

import flowmesh_config

RESOURCE = "https://api.wisprflow.ai/connect/mcp"
SCOPE = "openid offline_access"
DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
MCP_PROTOCOL = "2025-06-18"
BLOB = "wispr_account"

TOOL_SEARCH = "search_scratchpad_notes"
TOOL_GET = "get_scratchpad_note"
FORBIDDEN_TOOL = re.compile(r"dictation|history|transcript", re.IGNORECASE)

MAX_BODY = 1_000_000
REFRESH_SKEW_SECONDS = 120
SLOW_DOWN_STEP_SECONDS = 5
DEFAULT_POLL_SECONDS = 5
MAX_NOTE_CHARS = 4000
MAX_TITLE_CHARS = 120
NOTE_ID = re.compile(r"^[A-Za-z0-9_.:\-]{1,128}$")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class WisprAccountError(Exception):
    """`kind` is stable for the UI; `message` is a plain sentence for the person."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - urllib hook
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def clean_text(value: object, limit: int) -> str:
    """Untrusted text from Wispr: no control characters, bounded, trimmed."""
    if not isinstance(value, str):
        return ""
    return _CONTROL.sub(" ", value).strip()[:limit]


class WisprAccount:
    def __init__(self, resource: str = RESOURCE, *, loopback_http: bool = False, clock=time.time):
        self.resource = resource
        self._loopback_http = loopback_http
        self._clock = clock
        self._lock = threading.RLock()
        self._meta: dict | None = None
        self._pending: dict | None = None
        self._access: tuple[str, float] | None = None

    # ---- transport --------------------------------------------------------

    def _check_url(self, url: str) -> None:
        parsed = urlparse(url)
        loopback = parsed.hostname in {"127.0.0.1", "localhost"}
        if parsed.scheme == "https" and parsed.hostname and not parsed.username:
            return
        if self._loopback_http and parsed.scheme == "http" and loopback:
            return
        raise WisprAccountError("bad_response", "Wispr returned an endpoint that is not HTTPS.")

    def _request(self, method, url, *, form=None, payload=None, headers=None, timeout=20):
        self._check_url(url)
        out = {"Accept": "application/json, text/event-stream", "User-Agent": "FlowMesh"}
        data = None
        if form is not None:
            data = urlencode(form).encode()
            out["Content-Type"] = "application/x-www-form-urlencoded"
        elif payload is not None:
            data = json.dumps(payload).encode()
            out["Content-Type"] = "application/json"
        out.update(headers or {})
        request = urllib.request.Request(url, data=data, method=method, headers=out)
        try:
            with _OPENER.open(request, timeout=timeout) as response:
                return response.status, response.headers, response.read(MAX_BODY + 1)[:MAX_BODY]
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, exc.read(MAX_BODY)
        except (urllib.error.URLError, OSError, TimeoutError):
            raise WisprAccountError("unavailable", "Could not reach Wispr. Check your connection and try again.")

    @staticmethod
    def _json(body: bytes) -> dict:
        try:
            value = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise WisprAccountError("bad_response", "Wispr sent an answer FlowMesh could not read.")
        if not isinstance(value, dict):
            raise WisprAccountError("bad_response", "Wispr sent an unexpected answer.")
        return value

    # ---- discovery and registration ---------------------------------------

    def _discover(self) -> dict:
        with self._lock:
            if self._meta:
                return self._meta
            root = urlparse(self.resource)
            origin = f"{root.scheme}://{root.netloc}"
            status, _, body = self._request("GET", origin + "/.well-known/oauth-protected-resource")
            if status != 200:
                raise WisprAccountError("unavailable", "Wispr's sign-in service did not answer.")
            protected = self._json(body)
            if protected.get("resource") != self.resource:
                raise WisprAccountError("bad_response", "Wispr's sign-in service names a different resource.")
            issuers = protected.get("authorization_servers")
            if not isinstance(issuers, list) or not issuers or not isinstance(issuers[0], str):
                raise WisprAccountError("bad_response", "Wispr's sign-in service lists no issuer.")
            issuer = issuers[0].rstrip("/")
            self._check_url(issuer)
            status, _, body = self._request("GET", issuer + "/.well-known/oauth-authorization-server")
            if status != 200:
                raise WisprAccountError("unavailable", "Wispr's sign-in service did not answer.")
            meta = self._json(body)
            if str(meta.get("issuer", "")).rstrip("/") != issuer:
                raise WisprAccountError("bad_response", "Wispr's sign-in metadata names a different issuer.")
            host = urlparse(issuer).netloc
            endpoints = {}
            for key in ("token_endpoint", "registration_endpoint", "device_authorization_endpoint"):
                value = meta.get(key)
                if not isinstance(value, str) or urlparse(value).netloc != host:
                    raise WisprAccountError("unsupported", f"Wispr's sign-in service does not offer {key.replace('_', ' ')}.")
                self._check_url(value)
                endpoints[key] = value
            grants = meta.get("grant_types_supported")
            if isinstance(grants, list) and DEVICE_GRANT not in grants:
                raise WisprAccountError("unsupported", "Wispr's sign-in service does not offer device sign-in.")
            self._meta = {"issuer": issuer, **endpoints}
            return self._meta

    def _client_id(self, meta: dict) -> str:
        blob = flowmesh_config.load_blob(BLOB)
        if blob.get("issuer") == meta["issuer"] and isinstance(blob.get("client_id"), str) and blob["client_id"]:
            return blob["client_id"]
        status, _, body = self._request("POST", meta["registration_endpoint"], payload={
            "client_name": "FlowMesh",
            "redirect_uris": ["http://127.0.0.1/flowmesh-unused"],
            "grant_types": [DEVICE_GRANT, "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": SCOPE,
        })
        answer = self._json(body)
        client_id = answer.get("client_id")
        if status not in (200, 201) or not isinstance(client_id, str) or not client_id:
            raise WisprAccountError("unsupported", "Wispr declined to register FlowMesh as an app.")
        flowmesh_config.save_blob(BLOB, {"issuer": meta["issuer"], "client_id": client_id})
        return client_id

    # ---- device flow ------------------------------------------------------

    def status(self) -> dict:
        with self._lock:
            pending = self._pending
            if pending and self._clock() >= pending["expires_at"]:
                self._pending = pending = None
            if pending:
                return {"state": "pending", "detail": "Waiting for you to approve FlowMesh on Wispr's page.",
                        **self._public_pending(pending)}
            blob = flowmesh_config.load_blob(BLOB)
            if blob.get("refresh_token"):
                return {"state": "connected", "detail": "Signed in to Wispr Flow. Scratchpad notes are readable."}
            return {"state": "disconnected", "detail": "Not connected. Sign in to read your Scratchpad notes."}

    @staticmethod
    def _public_pending(pending: dict) -> dict:
        return {key: pending[key] for key in ("user_code", "verification_uri", "verification_uri_complete", "expires_in", "interval")}

    def begin(self) -> dict:
        with self._lock:
            meta = self._discover()
            client_id = self._client_id(meta)
            status, _, body = self._request("POST", meta["device_authorization_endpoint"], form={
                "client_id": client_id, "scope": SCOPE, "resource": self.resource,
            })
            answer = self._json(body)
            if status != 200:
                raise WisprAccountError("denied", "Wispr refused to start sign-in.")
            device_code, user_code = answer.get("device_code"), answer.get("user_code")
            uri = answer.get("verification_uri")
            if not all(isinstance(v, str) and v for v in (device_code, user_code, uri)):
                raise WisprAccountError("bad_response", "Wispr's sign-in answer was incomplete.")
            complete = answer.get("verification_uri_complete")
            complete = complete if isinstance(complete, str) else ""
            for link in (uri, complete):
                if link:
                    self._check_url(link)
            expires_in = int(answer.get("expires_in") or 600)
            interval = max(1, int(answer.get("interval") or DEFAULT_POLL_SECONDS))
            now = self._clock()
            self._pending = {
                "device_code": device_code, "client_id": client_id, "issuer": meta["issuer"],
                "user_code": clean_text(user_code, 32), "verification_uri": uri,
                "verification_uri_complete": complete, "expires_in": expires_in,
                "interval": interval, "expires_at": now + expires_in, "next_poll": now + interval,
            }
            return {"state": "pending", **self._public_pending(self._pending)}

    def poll(self) -> dict:
        with self._lock:
            pending = self._pending
            if not pending:
                return self.status()
            now = self._clock()
            if now >= pending["expires_at"]:
                self._pending = None
                return {"state": "expired", "detail": "The sign-in code expired. Start again."}
            if now < pending["next_poll"]:
                return {"state": "pending", "detail": "Waiting for you to approve FlowMesh on Wispr's page.",
                        **self._public_pending(pending)}
            meta = self._discover()
            status, _, body = self._request("POST", meta["token_endpoint"], form={
                "grant_type": DEVICE_GRANT, "client_id": pending["client_id"],
                "device_code": pending["device_code"], "resource": self.resource,
            })
            answer = self._json(body)
            if status == 200 and isinstance(answer.get("access_token"), str):
                self._pending = None
                self._keep_tokens(meta, pending["client_id"], answer)
                return {"state": "connected", "detail": "Signed in to Wispr Flow. Scratchpad notes are readable."}
            error = answer.get("error")
            if error == "authorization_pending":
                pending["next_poll"] = now + pending["interval"]
            elif error == "slow_down":
                pending["interval"] += SLOW_DOWN_STEP_SECONDS
                pending["next_poll"] = now + pending["interval"]
            elif error == "access_denied":
                self._pending = None
                return {"state": "denied", "detail": "Sign-in was declined on Wispr's page."}
            elif error == "expired_token":
                self._pending = None
                return {"state": "expired", "detail": "The sign-in code expired. Start again."}
            else:
                self._pending = None
                raise WisprAccountError("denied", "Wispr refused the sign-in.")
            return {"state": "pending", "detail": "Waiting for you to approve FlowMesh on Wispr's page.",
                    **self._public_pending(pending)}

    def disconnect(self) -> dict:
        """Forget the tokens on this machine. Wispr keeps its own record of the grant."""
        with self._lock:
            self._pending = None
            self._access = None
            blob = flowmesh_config.load_blob(BLOB)
            if blob.get("client_id"):
                flowmesh_config.save_blob(BLOB, {"issuer": blob.get("issuer"), "client_id": blob["client_id"]})
            else:
                flowmesh_config.clear_blob(BLOB)
            return {**self.status(), "detail": "Disconnected on this machine. Revoke the app in Wispr's settings to end the grant there."}

    # ---- tokens -----------------------------------------------------------

    def _keep_tokens(self, meta: dict, client_id: str, answer: dict) -> None:
        refresh = answer.get("refresh_token")
        blob = flowmesh_config.load_blob(BLOB)
        if not isinstance(refresh, str) or not refresh:
            refresh = blob.get("refresh_token")  # the server did not rotate it
        if not isinstance(refresh, str) or not refresh:
            raise WisprAccountError("unsupported", "Wispr did not grant lasting access (no refresh token).")
        flowmesh_config.save_blob(BLOB, {"issuer": meta["issuer"], "client_id": client_id, "refresh_token": refresh})
        lifetime = answer.get("expires_in")
        lifetime = lifetime if isinstance(lifetime, (int, float)) and lifetime > 0 else 300
        self._access = (answer["access_token"], self._clock() + float(lifetime))

    def _access_token(self) -> str:
        with self._lock:
            if self._access and self._access[1] - REFRESH_SKEW_SECONDS > self._clock():
                return self._access[0]
            blob = flowmesh_config.load_blob(BLOB)
            if not blob.get("refresh_token"):
                raise WisprAccountError("expired", "Not connected to Wispr Flow.")
            meta = self._discover()
            status, _, body = self._request("POST", meta["token_endpoint"], form={
                "grant_type": "refresh_token", "client_id": blob["client_id"],
                "refresh_token": blob["refresh_token"], "resource": self.resource,
            })
            answer = self._json(body)
            if status != 200 or not isinstance(answer.get("access_token"), str):
                if answer.get("error") in {"invalid_grant", "invalid_token"} or status in (400, 401):
                    flowmesh_config.save_blob(BLOB, {"issuer": blob.get("issuer"), "client_id": blob.get("client_id")})
                    self._access = None
                    raise WisprAccountError("expired", "Wispr sign-in expired. Connect again.")
                raise WisprAccountError("unavailable", "Wispr could not refresh the sign-in right now.")
            self._keep_tokens(meta, blob["client_id"], answer)
            return self._access[0]

    # ---- MCP --------------------------------------------------------------

    def _mcp(self, calls: list[tuple[str, dict]]) -> list[dict]:
        """One short MCP session: initialize, run `calls`, return each result."""
        token = self._access_token()
        session: dict[str, str] = {}
        counter = iter(range(1, 1000))

        def send(method: str, params: dict, expect: bool = True) -> dict:
            message: dict = {"jsonrpc": "2.0", "method": method, "params": params}
            request_id = None
            if expect:
                request_id = next(counter)
                message["id"] = request_id
            headers = {"Authorization": f"Bearer {token}", "MCP-Protocol-Version": MCP_PROTOCOL, **session}
            status, response_headers, body = self._request("POST", self.resource, payload=message, headers=headers)
            if status == 401:
                self._access = None
                raise WisprAccountError("expired", "Wispr sign-in expired. Connect again.")
            if status == 403:
                raise WisprAccountError("denied", "Wispr did not allow FlowMesh to read notes.")
            if status == 429:
                raise WisprAccountError("rate_limited", "Wispr asked FlowMesh to slow down. Try again in a minute.")
            if not expect:
                return {}
            if status != 200:
                raise WisprAccountError("unavailable", "Wispr's notes service is not available right now.")
            sid = response_headers.get("mcp-session-id")
            if sid:
                session["Mcp-Session-Id"] = sid
            return self._mcp_answer(response_headers.get("content-type", ""), body, request_id)

        send("initialize", {"protocolVersion": MCP_PROTOCOL, "capabilities": {},
                            "clientInfo": {"name": "flowmesh", "version": flowmesh_config.VERSION}})
        send("notifications/initialized", {}, expect=False)
        return [send(method, params) for method, params in calls]

    def _mcp_answer(self, content_type: str, body: bytes, request_id: int | None) -> dict:
        text = body.decode("utf-8", "replace")
        messages: list[dict] = []
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
                if "error" in message:
                    raise WisprAccountError("bad_response", "Wispr's notes service reported an error.")
                result = message.get("result")
                if isinstance(result, dict):
                    return result
        raise WisprAccountError("bad_response", "Wispr's notes service sent an unexpected answer.")

    @staticmethod
    def _tool_payload(result: dict):
        """A tool's structured answer, its text read as JSON, or its plain text."""
        if result.get("isError"):
            raise WisprAccountError("bad_response", "Wispr's notes tool reported an error.")
        if result.get("structuredContent") is not None:
            return result["structuredContent"]
        text = "\n".join(
            part.get("text", "") for part in result.get("content") or []
            if isinstance(part, dict) and part.get("type") == "text"
        )
        try:
            return json.loads(text)
        except ValueError:
            return text

    @staticmethod
    def _wanted_args(tool: dict, wanted: dict) -> dict:
        schema = tool.get("inputSchema")
        properties = schema.get("properties") if isinstance(schema, dict) else None
        if not isinstance(properties, dict):
            return wanted
        return {key: value for key, value in wanted.items() if key in properties}

    def _tools(self) -> dict[str, dict]:
        """Names of the allow-listed tools the server actually offers."""
        (listed,) = self._mcp([("tools/list", {})])
        found = {}
        for tool in listed.get("tools") or []:
            name = tool.get("name") if isinstance(tool, dict) else None
            if name in (TOOL_SEARCH, TOOL_GET) and not FORBIDDEN_TOOL.search(name):
                found[name] = tool
        if TOOL_SEARCH not in found or TOOL_GET not in found:
            raise WisprAccountError("unsupported", "Wispr's server does not offer the Scratchpad note tools.")
        return found

    # ---- notes ------------------------------------------------------------

    def list_notes(self, limit: int = 15) -> list[dict]:
        limit = max(1, min(int(limit), 25))
        tools = self._tools()
        (called,) = self._mcp([("tools/call", {
            "name": TOOL_SEARCH,
            "arguments": self._wanted_args(tools[TOOL_SEARCH], {"query": "", "limit": limit}),
        })])
        payload = self._tool_payload(called)
        items = payload.get("notes") if isinstance(payload, dict) else payload
        notes = []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            note_id = next((str(item[k]) for k in ("note_id", "id") if item.get(k)), "")
            if not NOTE_ID.fullmatch(note_id):
                continue
            title = " ".join(clean_text(item.get("title") or item.get("name") or "Untitled note", MAX_TITLE_CHARS).split())
            stamp = next((str(item[k]) for k in ("modified_at", "updated_at", "created_at") if item.get(k)), "")
            notes.append({"id": note_id, "title": title or "Untitled note", "modified_at": clean_text(stamp, 40)})
        return notes[:limit]

    def get_note(self, note_id: str) -> dict:
        if not isinstance(note_id, str) or not NOTE_ID.fullmatch(note_id):
            raise WisprAccountError("bad_request", "That is not a valid note id.")
        self._tools()
        (called,) = self._mcp([("tools/call", {"name": TOOL_GET, "arguments": {"note_id": note_id}})])
        payload = self._tool_payload(called)
        body = ""
        if isinstance(payload, dict):
            holders = [payload] + [payload[k] for k in ("note", "data") if isinstance(payload.get(k), dict)]
            for holder in holders:
                body = next((holder[k] for k in ("content", "text", "markdown") if isinstance(holder.get(k), str) and holder[k].strip()), "")
                if body:
                    break
        elif isinstance(payload, str):
            body = payload
        text = clean_text(body, MAX_NOTE_CHARS)
        if not text:
            raise WisprAccountError("empty", "That note is empty.")
        return {"id": note_id, "text": text, "truncated": len(body.strip()) > MAX_NOTE_CHARS}


ACCOUNT = WisprAccount()
