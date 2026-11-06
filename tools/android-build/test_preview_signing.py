import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("optimize-preview-apk.py")
SPEC = importlib.util.spec_from_file_location("optimize_preview_apk", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
DIGEST = "ab" * 32


def signing_report(store, *, variant="debug", config="debug", alias="AndroidDebugKey", digest=DIGEST):
    fingerprint = ":".join(digest[i:i + 2].upper() for i in range(0, len(digest), 2))
    return f"Variant: {variant}\nConfig: {config}\nStore: {store}\nAlias: {alias}\nSHA-256: {fingerprint}\n"


class PreviewSigningTests(unittest.TestCase):
    def test_uses_gradle_debug_store_outside_the_assumed_home_without_reading_key_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Path(temporary) / "actual-gradle-location" / "debug.keystore"
            store.parent.mkdir()
            store.write_bytes(b"fixture only, not a key")
            report = "Gradle task output\n" + signing_report(store)
            report += signing_report("null", variant="release", config="null", alias="null")
            report += signing_report(store, variant="debugAndroidTest")
            self.assertEqual(MODULE.debug_signing_from_report(report, DIGEST), (store, "AndroidDebugKey"))
            self.assertEqual(store.read_bytes(), b"fixture only, not a key")

    def test_rejects_ambiguous_mismatched_missing_and_non_debug_signing_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Path(temporary) / "debug.keystore"
            store.write_bytes(b"fixture only, not a key")
            valid = signing_report(store)
            cases = {
                "duplicate debug": valid + valid,
                "release only": signing_report(store, variant="release"),
                "non-debug config": signing_report(store, config="release"),
                "wrong source certificate": signing_report(store, digest="cd" * 32),
                "missing store": signing_report(Path(temporary) / "missing" / "debug.keystore"),
                "relative store": signing_report("debug.keystore"),
                "nonstandard alias": signing_report(store, alias="release-key"),
                "duplicate field": valid + "Store: " + str(store) + "\n",
                "oversized report": valid + "x" * (1024 * 1024),
            }
            for name, report in cases.items():
                with self.subTest(name=name), self.assertRaises(ValueError):
                    MODULE.debug_signing_from_report(report, DIGEST)

    def test_cli_requires_signing_metadata_instead_of_guessing_a_keystore(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "source.apk", "output.apk", "--sdk", "sdk", "--report", "report.json"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--signing-report", result.stderr)
        self.assertIn("--debug-keystore", result.stderr)

    def test_failed_sdk_diagnostic_retains_the_reason_without_password_arguments(self):
        message = "Missing keystore; --ks-pass pass:fixture-secret; --key-pass pass:second-fixture-secret"
        code = "import sys; sys.stderr.write(" + repr(message) + "); sys.exit(2)"
        with self.assertRaises(RuntimeError) as raised:
            MODULE.run_checked([sys.executable, "-c", code, "--ks-pass", "pass:fixture-secret", "--key-pass", "pass:second-fixture-secret"])
        diagnostic = str(raised.exception)
        self.assertIn("Missing keystore", diagnostic)
        self.assertIn("exit 2", diagnostic)
        self.assertNotIn("fixture-secret", diagnostic)
        self.assertNotIn("pass:", diagnostic)
        self.assertNotIn("import sys", diagnostic)


if __name__ == "__main__":
    unittest.main()
