"""The sanctioned Wispr connector, exercised against a protocol-faithful mock."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import bridge
import flowmesh_config
import wispr_account
from tests.helpers import BridgeTestCase
from tests.mock_wispr import MockWispr
from wispr_account import WisprAccount, WisprAccountError


class FakeClock:
    def __init__(self) -> None:
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class AccountTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {"FLOWMESH_CONFIG_DIR": os.path.join(self.tmp.name, "cfg")})
        env.start()
        self.addCleanup(env.stop)
        # Never touch the developer's real OS credential store from a test.
        keyring = patch.object(flowmesh_config, "keyring", None)
        keyring.start()
        self.addCleanup(keyring.stop)
        self.clock = FakeClock()

    REDIRECT = "http://127.0.0.1:53682/oauth/wispr/callback"

    def account(self, mock: MockWispr) -> WisprAccount:
        return WisprAccount(mock.resource, loopback_http=True, clock=self.clock)

    def authorize(self, url: str) -> tuple[str, str]:
        """What the browser does at Wispr's page: follow the authorize URL, return (code, state)."""
        opener = urllib.request.build_opener(_NoRedirect)
        try:
            opener.open(url, timeout=10)
        except urllib.error.HTTPError as exc:
            query = parse_qs(urlparse(exc.headers["Location"]).query)
            return (query.get("code") or [query.get("error", [""])[0]])[0], query["state"][0]
        raise AssertionError("authorize did not redirect")

    def sign_in(self, mock: MockWispr) -> WisprAccount:
        account = self.account(mock)
        url = account.begin(self.REDIRECT)["authorization_url"]
        code, state = self.authorize(url)
        ok, message = account.complete(code, state)
        self.assertTrue(ok, message)
        return account


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class BrowserSignInTest(AccountTestCase):
    def test_starts_disconnected(self):
        with MockWispr() as mock:
            self.assertEqual(self.account(mock).status()["state"], "disconnected")

    def test_begin_returns_the_wispr_url_with_pkce_and_never_the_verifier(self):
        with MockWispr() as mock:
            started = self.account(mock).begin(self.REDIRECT)
            url = urlparse(started["authorization_url"])
            query = parse_qs(url.query)
            self.assertEqual(url.path, "/oauth2/authorize")
            self.assertEqual(query["code_challenge_method"], ["S256"])
            self.assertEqual(query["redirect_uri"], [self.REDIRECT])
            self.assertEqual(query["resource"], [mock.resource])
            self.assertEqual(started["state"], "pending")
            self.assertNotIn("code_verifier", started["authorization_url"])
            self.assertNotIn("verifier", json.dumps(started))

    def test_client_is_a_public_client_registered_once_for_the_exact_redirect(self):
        with MockWispr() as mock:
            account = self.account(mock)
            account.begin(self.REDIRECT)
            account.begin(self.REDIRECT)
            self.assertEqual(mock.registrations, 1)
            registration = mock.posted("/oauth2/register")[0]
            self.assertEqual(registration["token_endpoint_auth_method"], "none")
            self.assertEqual(registration["redirect_uris"], [self.REDIRECT])
            self.assertEqual(registration["grant_types"], ["authorization_code", "refresh_token"])

    def test_a_good_callback_connects_and_stores_only_the_refresh_token_and_client(self):
        with MockWispr() as mock:
            account = self.sign_in(mock)
            self.assertEqual(account.status()["state"], "connected")
            blob = flowmesh_config.load_blob("wispr_account")
            self.assertEqual(blob["refresh_token"], "rt-1")
            self.assertNotIn("access_token", blob)
            exchange = mock.posted("/oauth2/token")[-1]
            self.assertEqual((exchange["grant_type"], exchange["resource"]), ("authorization_code", mock.resource))
            self.assertTrue(exchange["code_verifier"])

    def test_a_callback_with_the_wrong_state_is_ignored_and_does_not_disturb_the_sign_in(self):
        with MockWispr() as mock:
            account = self.account(mock)
            url = account.begin(self.REDIRECT)["authorization_url"]
            code, state = self.authorize(url)
            ok, _ = account.complete(code, "attacker-state")
            self.assertFalse(ok)
            self.assertEqual(account.status()["state"], "pending", "a forged callback must not cancel the real sign-in")
            self.assertEqual(len(mock.posted("/oauth2/token")), 0, "no code may be exchanged for a wrong state")
            self.assertTrue(account.complete(code, state)[0])

    def test_state_is_single_use(self):
        with MockWispr() as mock:
            account = self.account(mock)
            code, state = self.authorize(account.begin(self.REDIRECT)["authorization_url"])
            self.assertTrue(account.complete(code, state)[0])
            self.assertFalse(account.complete(code, state)[0], "a replayed callback must be refused")

    def test_a_declined_sign_in_is_reported_once(self):
        with MockWispr(deny=True) as mock:
            account = self.account(mock)
            code, state = self.authorize(account.begin(self.REDIRECT)["authorization_url"])
            ok, _ = account.complete("", state, error="access_denied")
            self.assertFalse(ok)
            self.assertEqual(account.status()["state"], "denied")
            self.assertEqual(account.status()["state"], "disconnected")

    def test_a_rejected_code_exchange_is_denied_not_connected(self):
        with MockWispr(reject_code=True) as mock:
            account = self.account(mock)
            code, state = self.authorize(account.begin(self.REDIRECT)["authorization_url"])
            self.assertFalse(account.complete(code, state)[0])
            self.assertEqual(account.status()["state"], "denied")
            self.assertEqual(account.status()["state"], "disconnected")

    def test_an_old_sign_in_link_expires(self):
        with MockWispr() as mock:
            account = self.account(mock)
            code, state = self.authorize(account.begin(self.REDIRECT)["authorization_url"])
            self.clock.advance(601)
            self.assertFalse(account.complete(code, state)[0])
            self.assertEqual(account.status()["state"], "expired")

    def test_only_this_apps_own_loopback_callback_is_accepted_as_a_return_address(self):
        with MockWispr() as mock:
            account = self.account(mock)
            for bad in ("https://evil.example/oauth/wispr/callback", "http://127.0.0.1/oauth/wispr/callback",
                        "http://127.0.0.1:1/other", "http://example.com:80/oauth/wispr/callback",
                        "http://127.0.0.1:1/oauth/wispr/callback?x=1"):
                with self.assertRaises(WisprAccountError, msg=bad):
                    account.begin(bad)
            self.assertEqual(mock.registrations, 0)

    def test_prefetch_registers_in_the_background_so_connect_is_instant(self):
        with MockWispr() as mock:
            account = self.account(mock)
            account.prefetch(self.REDIRECT)
            deadline = time.time() + 5
            while mock.registrations < 1 and time.time() < deadline:
                time.sleep(0.02)
            self.assertEqual(mock.registrations, 1)
            before = len(mock.log)
            account.begin(self.REDIRECT)
            self.assertEqual(len(mock.log), before, "begin() should need no network after prefetch")

    def test_disconnect_forgets_tokens_but_says_the_grant_survives_at_wispr(self):
        with MockWispr() as mock:
            account = self.sign_in(mock)
            result = account.disconnect()
            self.assertEqual(result["state"], "disconnected")
            self.assertIn("Revoke", result["detail"])
            self.assertNotIn("refresh_token", flowmesh_config.load_blob("wispr_account"))


class NotesTest(AccountTestCase):
    def test_lists_notes_with_control_characters_stripped(self):
        with MockWispr() as mock:
            notes = self.sign_in(mock).list_notes()
            self.assertEqual([n["id"] for n in notes], ["n-1", "n-2"])
            self.assertNotIn("\x07", notes[0]["title"])

    def test_reads_one_note_and_strips_control_characters(self):
        with MockWispr() as mock:
            note = self.sign_in(mock).get_note("n-1")
            self.assertIn("Follow up with Rohan", note["text"])
            self.assertNotIn("\x00", note["text"])

    def test_rejects_ids_that_are_not_plain_identifiers(self):
        with MockWispr() as mock:
            account = self.sign_in(mock)
            for bad in ("", "../x", "a b", "n-1\n", "x" * 200, None):
                with self.assertRaises(WisprAccountError) as caught:
                    account.get_note(bad)
                self.assertEqual(caught.exception.kind, "bad_request")

    def test_works_when_the_server_answers_with_server_sent_events(self):
        with MockWispr(sse=True) as mock:
            self.assertEqual(len(self.sign_in(mock).list_notes()), 2)

    def test_only_allow_listed_tools_are_ever_called(self):
        with MockWispr(tools=["search_scratchpad_notes", "get_scratchpad_note", "get_dictation_history"]) as mock:
            account = self.sign_in(mock)
            account.list_notes()
            account.get_note("n-2")
            called = {d["params"]["name"] for d in mock.posted("/connect/mcp") if d.get("method") == "tools/call"}
            self.assertEqual(called, {"search_scratchpad_notes", "get_scratchpad_note"})

    def test_a_server_without_the_note_tools_is_unsupported_not_empty(self):
        with MockWispr(tools=["something_else"]) as mock:
            with self.assertRaises(WisprAccountError) as caught:
                self.sign_in(mock).list_notes()
            self.assertEqual(caught.exception.kind, "unsupported")


class TokenLifecycleTest(AccountTestCase):
    def test_refreshes_an_expired_access_token_and_keeps_the_rotated_refresh_token(self):
        with MockWispr() as mock:
            account = self.sign_in(mock)
            self.clock.advance(4000)
            self.assertEqual(len(account.list_notes()), 2)
            self.assertEqual(flowmesh_config.load_blob("wispr_account")["refresh_token"], "rt-2")

    def test_a_revoked_grant_becomes_expired_and_drops_the_token(self):
        with MockWispr() as mock:
            account = self.sign_in(mock)
            mock.revoked = True
            self.clock.advance(4000)
            with self.assertRaises(WisprAccountError) as caught:
                account.list_notes()
            self.assertEqual(caught.exception.kind, "expired")
            self.assertEqual(account.status()["state"], "disconnected")

    def test_metadata_pointing_the_token_endpoint_at_another_host_is_refused(self):
        with MockWispr(evil_token_host=True) as mock:
            with self.assertRaises(WisprAccountError) as caught:
                self.account(mock).begin(self.REDIRECT)
            self.assertEqual(caught.exception.kind, "unsupported")
            self.assertEqual(mock.registrations, 0, "registered with a server that failed validation")

    def test_plain_http_is_refused_unless_loopback_testing_is_enabled(self):
        with MockWispr() as mock:
            strict = WisprAccount(mock.resource, loopback_http=False, clock=self.clock)
            with self.assertRaises(WisprAccountError):
                strict.begin(self.REDIRECT)


class BridgeRoutesTest(BridgeTestCase):
    def setUp(self) -> None:
        super().setUp()
        keyring = patch.object(flowmesh_config, "keyring", None)
        keyring.start()
        self.addCleanup(keyring.stop)
        self.clock = FakeClock()
        self.mock_cm = MockWispr()
        self.mock = self.mock_cm.__enter__()
        self.addCleanup(self.mock_cm.__exit__, None, None, None)
        account = WisprAccount(self.mock.resource, loopback_http=True, clock=self.clock)
        patcher = patch.object(bridge, "ACCOUNT", account)
        patcher.start()
        self.addCleanup(patcher.stop)

    def wispr_redirect(self, url: str) -> dict:
        opener = urllib.request.build_opener(_NoRedirect)
        try:
            opener.open(url, timeout=10)
        except urllib.error.HTTPError as exc:
            return {k: v[0] for k, v in parse_qs(urlparse(exc.headers["Location"]).query).items()}
        raise AssertionError("no redirect")

    def browser_returns(self, url: str, **override) -> tuple[int, str]:
        """Follow Wispr's authorize URL, then do what the browser does next: GET our callback
        (no session token: a browser navigation cannot carry one)."""
        params = {**self.wispr_redirect(url), **override}
        target = self.base + "/oauth/wispr/callback?" + urllib.parse.urlencode(params)
        try:
            with urllib.request.urlopen(target, timeout=10) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as err:
            return err.code, err.read().decode()

    def test_full_journey_over_http_never_leaks_a_secret(self):
        bodies = []
        status, _, body = self.call("GET", "/api/wispr/account")
        bodies.append(body)
        self.assertEqual(self.json_of(body)["state"], "disconnected")
        status, _, body = self.call("POST", "/api/wispr/account/connect", {})
        bodies.append(body)
        started = self.json_of(body)
        self.assertEqual((status, started["state"]), (200, "pending"))
        self.assertEqual(parse_qs(urlparse(started["authorization_url"]).query)["redirect_uri"], [self.base + "/oauth/wispr/callback"])
        code, page = self.browser_returns(started["authorization_url"])
        self.assertEqual(code, 200)
        self.assertIn("Connected", page)
        status, _, body = self.call("POST", "/api/wispr/account/poll", {})
        bodies.append(body)
        self.assertEqual(self.json_of(body)["state"], "connected")
        status, _, body = self.call("GET", "/api/wispr/account/notes")
        bodies.append(body)
        self.assertEqual(len(self.json_of(body)["notes"]), 2)
        status, _, body = self.call("POST", "/api/wispr/account/note", {"note_id": "n-1"})
        bodies.append(body)
        self.assertIn("research sprint", self.json_of(body)["text"])
        for secret in ("at-1", "rt-1", "auth-code-1", "code_verifier"):
            for text in bodies + [page]:
                self.assertNotIn(secret, text)

    def test_the_callback_needs_no_token_but_a_forged_one_is_rejected(self):
        started = self.json_of(self.call("POST", "/api/wispr/account/connect", {})[2])
        status, page = self.browser_returns(started["authorization_url"], state="not-the-state")
        self.assertEqual(status, 400)
        self.assertIn("not valid", page)
        self.assertEqual(self.json_of(self.call("GET", "/api/wispr/account")[2])["state"], "pending")
        self.assertEqual(len(self.mock.posted("/oauth2/token")), 0)

    def test_a_declined_sign_in_shows_a_plain_page_and_reports_denied(self):
        started = self.json_of(self.call("POST", "/api/wispr/account/connect", {})[2])
        status, page = self.browser_returns(started["authorization_url"], error="access_denied")
        self.assertEqual(status, 400)
        self.assertIn("declined", page)
        self.assertEqual(self.json_of(self.call("POST", "/api/wispr/account/poll", {})[2])["state"], "denied")

    def test_the_callback_page_is_locked_down_and_the_code_is_never_logged(self):
        started = self.json_of(self.call("POST", "/api/wispr/account/connect", {})[2])
        query = self.wispr_redirect(started["authorization_url"])
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            url = self.base + "/oauth/wispr/callback?code=" + query["code"] + "&state=" + query["state"]
            with urllib.request.urlopen(url, timeout=10) as response:
                headers = response.headers
        self.assertIn("default-src 'none'", headers["Content-Security-Policy"])
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertNotIn("auth-code-1", err.getvalue())
        self.assertNotIn(query["state"], err.getvalue())

    def test_routes_demand_the_session_token(self):
        for method, path, payload in (("GET", "/api/wispr/account", None), ("GET", "/api/wispr/account/notes", None),
                                      ("POST", "/api/wispr/account/connect", {})):
            status, _, _ = self.call(method, path, payload, token="none")
            self.assertEqual(status, 401, path)

    def test_note_route_accepts_only_an_id(self):
        status, _, _ = self.call("POST", "/api/wispr/account/note", {"note_id": "n-1", "text": "rm -rf /"})
        self.assertEqual(status, 400)

    def test_not_connected_is_409_not_401(self):
        status, _, body = self.call("GET", "/api/wispr/account/notes")
        self.assertEqual(status, 409)
        self.assertEqual(self.json_of(body)["kind"], "expired")


if __name__ == "__main__":
    unittest.main()
