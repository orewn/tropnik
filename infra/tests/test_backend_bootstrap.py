"""Regression checks for the production API's health response contract."""

import importlib.util
import io
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "verify-backend-bootstrap.py"
SPEC = importlib.util.spec_from_file_location("verify_backend_bootstrap", SCRIPT)
BOOTSTRAP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BOOTSTRAP)


class Response(io.BytesIO):
    def __init__(self, body, status=200):
        super().__init__(body)
        self.status = status


class HealthResponseContractTest(unittest.TestCase):
    def test_accepts_ready_and_live_in_the_existing_api_envelope(self):
        cases = [
            ("ready", b'{"data":{"status":"ready"},"meta":{"mode":"production"}}\n'),
            ("ok", b'{"data":{"status":"ok"},"meta":{"mode":"production"}}\n'),
        ]
        for expected, body in cases:
            with self.subTest(expected=expected):
                self.assertTrue(BOOTSTRAP.health_response_matches(Response(body), expected))

    def test_flat_status_and_nonproduction_envelopes_cannot_qualify(self):
        bodies = [
            b'{"status":"ready"}',
            b'{"data":{"status":"ready"}}',
            b'{"data":{"status":"ready"},"meta":{"mode":"preview"}}',
            b'{"data":{"status":"ready"},"meta":null}',
            b'{"data":{"status":"ready"},"meta":{"mode":"production","unexpected":true}}',
        ]
        for body in bodies:
            with self.subTest(body=body):
                self.assertFalse(BOOTSTRAP.health_response_matches(Response(body), "ready"))

    def test_liveness_does_not_substitute_for_readiness(self):
        live = b'{"data":{"status":"ok"},"meta":{"mode":"production"}}'
        self.assertFalse(BOOTSTRAP.health_response_matches(Response(live), "ready"))

    def test_http_failure_cannot_qualify_even_with_a_success_body(self):
        ready = b'{"data":{"status":"ready"},"meta":{"mode":"production"}}'
        for code in (301, 503):
            with self.subTest(code=code):
                self.assertFalse(BOOTSTRAP.health_response_matches(Response(ready, code), "ready"))

    def test_invalid_and_oversized_responses_fail_closed(self):
        bodies = [
            b'', b'null', b'[]', b'not JSON', b'\xff',
            b'{"data":{"status":"ready"},"meta":{"mode":"production"}} trailing',
            b'{"data":{"status":"ready"},"meta":{"mode":"production"}}' + b' ' * 8192,
        ]
        for body in bodies:
            with self.subTest(body=body[:80]):
                self.assertFalse(BOOTSTRAP.health_response_matches(Response(body), "ready"))


if __name__ == "__main__":
    unittest.main()
