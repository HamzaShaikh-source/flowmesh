"""Connect a Wispr Flow account through Wispr's own, supported interface.

Why this file exists
--------------------
`wispr_source.py` reads Wispr's local history database. That works, but Wispr does
not document that file as an integration point. Wispr *does* publish a remote MCP
server (`https://api.wisprflow.ai/connect/mcp`) protected by OAuth, whose tools expose
the user's Scratchpad notes. This module is the sanctioned path: the user signs in
on Wispr's own page, FlowMesh holds a refresh token, and notes arrive over HTTPS.

Hard rules, each enforced below rather than promised:

1. **Browser sign-in with PKCE.** The user signs in on Wispr's own page and is sent back
   to a loopback URL on this machine; FlowMesh never sees a password. (Wispr advertises a
   device flow, but its device page rejects third-party codes with "Missing
   external_auth_id", so authorization code + PKCE is the flow that actually works.)
2. **Public client, no secret.** `token_endpoint_auth_method` is `none` and the code is
   bound to a one-time verifier; nothing sensitive is embedded in the shipped app.
3. **Allow-listed tools.** Only the Scratchpad note tools are ever called. Anything
   whose name mentions dictation, history or transcripts is refused by name.
4. **Wispr's text is untrusted.** It is stripped of control characters, length-capped,
   and only ever placed in the command box for the user to read. It is never planned
   or executed without the normal plan-approve-run step.
5. **Tokens never leave this module.** Callers get state and note text, never a token,
   PKCE verifier or authorization code.
6. **No redirects, HTTPS only** (loopback HTTP is accepted solely for tests), and
   every endpoint named by discovery must sit on the issuer's own host.

Not verified against a live account until the owner signs in once; see
docs/WISPR-CONNECTOR.md for exactly what was and was not exercised.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlparse

import flowmesh_config

RESOURCE = "https://api.wisprflow.ai/connect/mcp"
SCOPE = "openid offline_access"
CALLBACK_PATH = "/oauth/wispr/callback"
SIGN_IN_SECONDS = 600
REQUEST_TIMEOUT = 10
MCP_PROTOCOL = "2025-06-18"
BLOB = "wispr_account"

TOOL_SEARCH = "search_scratchpad_notes"
TOOL_GET = "get_scratchpad_note"
FORBIDDEN_TOOL = re.compile(r"dictation|history|transcript", re.IGNORECASE)

MAX_BODY = 1_000_000
REFRESH_SKEW_SECONDS = 120
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
        self._clients: dict[str, str] = {}
        self._register_lock = threading.Lock()
        self._outcome: dict | None = None

    # ---- transport --------------------------------------------------------

    def _check_url(self, url: str) -> None:
        parsed = urlparse(url)
        loopback = parsed.hostname in {"127.0.0.1", "localhost"}
        if parsed.scheme == "https" and parsed.hostname and not parsed.username:
            return
        if self._loopback_http and parsed.scheme == "http" and loopback:
            return
        raise WisprAccountError("bad_response", "Wispr returned an endpoint that is not HTTPS.")

    def _request(self, method, url, *, form=None, payload=None, headers=None, timeout=REQUEST_TIMEOUT):
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
            for key in ("token_endpoint", "registration_endpoint", "authorization_endpoint"):
                value = meta.get(key)
                if not isinstance(value, str) or urlparse(value).netloc != host:
                    raise WisprAccountError("unsupported", f"Wispr's sign-in service does not offer {key.replace('_', ' ')}.")
                self._check_url(value)
                endpoints[key] = value
            grants = meta.get("grant_types_supported")
            if isinstance(grants, list) and "authorization_code" not in grants:
                raise WisprAccountError("unsupported", "Wispr's sign-in service does not offer browser sign-in.")
            methods = meta.get("code_challenge_methods_supported")
            if isinstance(methods, list) and "S256" not in methods:
                raise WisprAccountError("unsupported", "Wispr's sign-in service does not support PKCE.")
            self._meta = {"issuer": issuer, **endpoints}
            return self._meta

    def _register(self, meta: dict, redirect_uri: str) -> str:
        """A public client for this exact redirect URI, registered once per launch."""
        # One registration at a time: the background prefetch and a click on Connect can
        # arrive together, and both must end up with the same client.
        with self._register_lock:
            known = self._clients.get(redirect_uri)
            if known:
                return known
            status, _, body = self._request("POST", meta["registration_endpoint"], payload={
                "client_name": "FlowMesh",
                "redirect_uris": [redirect_uri],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
                "scope": SCOPE,
            })
            answer = self._json(body)
            client_id = answer.get("client_id")
            if status not in (200, 201) or not isinstance(client_id, str) or not client_id:
                raise WisprAccountError("unsupported", "Wispr declined to register FlowMesh as an app.")
            self._clients[redirect_uri] = client_id
            return client_id

    def _check_redirect(self, redirect_uri: str) -> None:
        parsed = urlparse(redirect_uri)
        if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"} or not parsed.port
                or parsed.path != CALLBACK_PATH or parsed.query or parsed.fragment):
            raise WisprAccountError("bad_request", "The sign-in return address must be this app's own loopback callback.")

    def prefetch(self, redirect_uri: str) -> None:
        """Warm discovery and registration in the background so Connect is instant."""
        def work() -> None:
            try:
                self._check_redirect(redirect_uri)
                self._register(self._discover(), redirect_uri)
            except WisprAccountError:
                pass  # begin() reports a real error when the person actually clicks Connect

        threading.Thread(target=work, daemon=True).start()

    # ---- browser sign-in --------------------------------------------------

    def status(self) -> dict:
        with self._lock:
            if self._outcome:
                outcome, self._outcome = self._outcome, None
                return outcome
            pending = self._pending
            if pending and self._clock() >= pending["expires_at"]:
                self._pending = pending = None
                return {"state": "expired", "detail": "The sign-in link expired. Start again."}
            if pending:
                return {"state": "pending", "detail": "Finish signing in on Wispr's page. This updates by itself.",
                        "authorization_url": pending["url"],
                        "expires_in": max(0, int(pending["expires_at"] - self._clock()))}
            blob = flowmesh_config.load_blob(BLOB)
            if blob.get("refresh_token"):
                return {"state": "connected", "detail": "Signed in to Wispr Flow. Scratchpad notes are readable."}
            return {"state": "disconnected", "detail": "Not connected. Sign in to read your Scratchpad notes."}

    def begin(self, redirect_uri: str) -> dict:
        """Prepare a sign-in. Returns the Wispr URL the person must open."""
        self._check_redirect(redirect_uri)
        meta = self._discover()
        client_id = self._register(meta, redirect_uri)
        verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = secrets.token_urlsafe(24)
        url = meta["authorization_endpoint"] + "?" + urlencode({
            "response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri, "scope": SCOPE,
            "state": state, "code_challenge": challenge, "code_challenge_method": "S256", "resource": self.resource,
        })
        with self._lock:
            self._outcome = None
            self._pending = {"state": state, "verifier": verifier, "client_id": client_id, "redirect_uri": redirect_uri,
                             "url": url, "expires_at": self._clock() + SIGN_IN_SECONDS}
        return self.status()

    def poll(self) -> dict:
        """What the page polls while the person signs in: local state only, no network."""
        return self.status()

    def complete(self, code: str, state: str, error: str = "") -> tuple[bool, str]:
        """Handle the browser coming back to the loopback callback. Returns (ok, sentence)."""
        with self._lock:
            pending = self._pending
            if not pending or not isinstance(state, str) or not hmac.compare_digest(state, pending["state"]):
                # Not ours (or a replay): ignore it without disturbing a sign-in in progress.
                return False, "This sign-in link is not valid any more. Start again from FlowMesh."
            self._pending = None  # single use, whatever happens next
            if self._clock() >= pending["expires_at"]:
                self._outcome = {"state": "expired", "detail": "The sign-in link expired. Start again."}
                return False, "The sign-in link expired. Start again from FlowMesh."
            if error:
                self._outcome = {"state": "denied", "detail": "Sign-in was declined on Wispr's page."}
                return False, "Sign-in was declined."
            if not isinstance(code, str) or not code or len(code) > 2048:
                self._outcome = {"state": "denied", "detail": "Wispr did not return a sign-in code."}
                return False, "Wispr did not return a sign-in code."
            try:
                meta = self._discover()
                status, _, body = self._request("POST", meta["token_endpoint"], form={
                    "grant_type": "authorization_code", "client_id": pending["client_id"], "code": code,
                    "redirect_uri": pending["redirect_uri"], "code_verifier": pending["verifier"], "resource": self.resource,
                })
                answer = self._json(body)
                if status != 200 or not isinstance(answer.get("access_token"), str):
                    raise WisprAccountError("denied", "Wispr refused the sign-in.")
                self._keep_tokens(meta, pending["client_id"], answer)
            except WisprAccountError as exc:
                self._outcome = {"state": "denied", "detail": exc.message}
                return False, exc.message
            return True, "Signed in. You can close this tab and return to FlowMesh."

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
