"""The sanctioned Wispr connector, exercised against a protocol-faithful mock."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from unittest.mock import patch

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

    def account(self, mock: MockWispr) -> WisprAccount:
        return WisprAccount(mock.resource, loopback_http=True, clock=self.clock)

    def sign_in(self, mock: MockWispr) -> WisprAccount:
        account = self.account(mock)
        account.begin()
        self.clock.advance(6)
        while account.poll()["state"] == "pending":
            self.clock.advance(6)
        return account


class DeviceFlowTest(AccountTestCase):
    def test_starts_disconnected(self):
        with MockWispr() as mock:
            self.assertEqual(self.account(mock).status()["state"], "disconnected")

    def test_begin_shows_the_code_and_never_the_device_code(self):
        with MockWispr() as mock:
            started = self.account(mock).begin()
            self.assertEqual(started["user_code"], "ABCD-1234")
            self.assertTrue(started["verification_uri"].endswith("/activate"))
            self.assertNotIn("dev-secret", json.dumps(started))
            self.assertNotIn("cid-1", json.dumps(started))

    def test_client_is_registered_once_as_a_public_client(self):
        with MockWispr() as mock:
            account = self.account(mock)
            account.begin()
            account.begin()
            self.assertEqual(mock.registrations, 1)
            registration = mock.posted("/oauth2/register")[0]
            self.assertEqual(registration["token_endpoint_auth_method"], "none")
            self.assertIn("urn:ietf:params:oauth:grant-type:device_code", registration["grant_types"])

    def test_polling_respects_the_server_interval(self):
        with MockWispr(pending_polls=0) as mock:
            account = self.account(mock)
            account.begin()
            account.poll()
            account.poll()
            self.assertEqual(len(mock.posted("/oauth2/token")), 0, "polled before the interval elapsed")
            self.clock.advance(6)
            self.assertEqual(account.poll()["state"], "connected")
            self.assertEqual(len(mock.posted("/oauth2/token")), 1)

    def test_pending_then_connected_and_the_refresh_token_is_stored(self):
        with MockWispr(pending_polls=2) as mock:
            account = self.sign_in(mock)
            self.assertEqual(account.status()["state"], "connected")
            self.assertEqual(flowmesh_config.load_blob("wispr_account")["refresh_token"], "rt-1")
            token_request = mock.posted("/oauth2/token")[-1]
            self.assertEqual(token_request["resource"], mock.resource)

    def test_an_expired_code_is_reported_not_retried_forever(self):
        with MockWispr() as mock:
            account = self.account(mock)
            account.begin()
            self.clock.advance(601)
            self.assertEqual(account.poll()["state"], "expired")
            self.assertEqual(account.status()["state"], "disconnected")

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
                self.account(mock).begin()
            self.assertEqual(caught.exception.kind, "unsupported")
            self.assertEqual(mock.registrations, 0, "registered with a server that failed validation")

    def test_plain_http_is_refused_unless_loopback_testing_is_enabled(self):
        with MockWispr() as mock:
            strict = WisprAccount(mock.resource, loopback_http=False, clock=self.clock)
            with self.assertRaises(WisprAccountError):
                strict.begin()


class BridgeRoutesTest(BridgeTestCase):
    def setUp(self) -> None:
        super().setUp()
        keyring = patch.object(flowmesh_config, "keyring", None)
        keyring.start()
        self.addCleanup(keyring.stop)
        self.clock = FakeClock()
        self.mock_cm = MockWispr(pending_polls=0)
        self.mock = self.mock_cm.__enter__()
        self.addCleanup(self.mock_cm.__exit__, None, None, None)
        account = WisprAccount(self.mock.resource, loopback_http=True, clock=self.clock)
        patcher = patch.object(bridge, "ACCOUNT", account)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_full_journey_over_http_never_leaks_a_secret(self):
        bodies = []
        status, _, body = self.call("GET", "/api/wispr/account")
        bodies.append(body)
        self.assertEqual(self.json_of(body)["state"], "disconnected")
        status, _, body = self.call("POST", "/api/wispr/account/connect", {})
        bodies.append(body)
        self.assertEqual((status, self.json_of(body)["user_code"]), (200, "ABCD-1234"))
        self.clock.advance(6)
        status, _, body = self.call("POST", "/api/wispr/account/poll", {})
        bodies.append(body)
        self.assertEqual(self.json_of(body)["state"], "connected")
        status, _, body = self.call("GET", "/api/wispr/account/notes")
        bodies.append(body)
        self.assertEqual(len(self.json_of(body)["notes"]), 2)
        status, _, body = self.call("POST", "/api/wispr/account/note", {"note_id": "n-1"})
        bodies.append(body)
        self.assertIn("research sprint", self.json_of(body)["text"])
        for secret in ("at-1", "rt-1", "dev-secret", "cid-1"):
            for text in bodies:
                self.assertNotIn(secret, text)

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
