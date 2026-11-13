import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("production_signing", Path(__file__).with_name("verify-production.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
DIGEST = "ab" * 32


class ProductionSigningTests(unittest.TestCase):
    def test_unsigned_requires_expected_sdk_result_and_no_signing_material(self):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / "fixture.apk"
            with zipfile.ZipFile(apk, "w") as archive:
                archive.writestr("AndroidManifest.xml", b"fixture only")
            expected = MODULE.subprocess.CompletedProcess([], 1, "", "DOES NOT VERIFY\nERROR: Missing META-INF/MANIFEST.MF\n")
            MODULE.unsigned_signature(apk, expected)
            for result in (MODULE.subprocess.CompletedProcess([], 17, "", ""),
                           MODULE.subprocess.CompletedProcess([], 1, "", "JVM crashed"),
                           MODULE.subprocess.CompletedProcess([], 0, "", expected.stderr),
                           MODULE.subprocess.CompletedProcess([], 1, "", expected.stderr + "ERROR: corrupted APK\n")):
                with self.assertRaises(ValueError):
                    MODULE.unsigned_signature(apk, result)
            with zipfile.ZipFile(apk, "a") as archive:
                archive.writestr("META-INF/OWNER.RSA", b"fixture signature marker")
            with self.assertRaisesRegex(ValueError, "JAR signing material"):
                MODULE.unsigned_signature(apk, expected)

    def test_payload_must_match_the_current_source_asset_bytes_and_inventory(self):
        spec = importlib.util.spec_from_file_location("production_payload_fixture", Path(__file__).with_name("verify-apk.py"))
        payload = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(payload)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assets = root / "android/app/src/main/assets"
            assets.mkdir(parents=True)
            source = assets / "catalogue.json"
            source.write_bytes(b"reviewed source")
            apk = root / "fixture.apk"
            with zipfile.ZipFile(apk, "w") as archive:
                archive.writestr("assets/catalogue.json", source.read_bytes())
            with zipfile.ZipFile(apk) as archive:
                self.assertTrue(payload.verify_source_assets(archive, root)["sourceAssetParityVerified"])
                source.write_bytes(b"different source, same version")
                with self.assertRaisesRegex(ValueError, "differs from the reviewed source"):
                    payload.verify_source_assets(archive, root)
                source.write_bytes(b"reviewed source")
                (assets / "new.json").write_bytes(b"new source")
                with self.assertRaisesRegex(ValueError, "inventory differs"):
                    payload.verify_source_assets(archive, root)

    def test_only_binary_art_profiles_bound_to_this_compiler_output_are_admitted(self):
        spec = importlib.util.spec_from_file_location("production_profile_fixture", Path(__file__).with_name("verify-apk.py"))
        payload = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(payload)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assets = root / "android/app/src/main/assets"
            assets.mkdir(parents=True)
            (assets / "source.txt").write_bytes(b"source")
            compiled = root / "android/app/build/intermediates/art_profile/release/compileReleaseArtProfile/baseline.prof"
            compiled.parent.mkdir(parents=True)
            compiled.write_bytes(b"pro\x00015\x00fixture binary payload")
            apk = root / "fixture.apk"
            with zipfile.ZipFile(apk, "w") as archive:
                archive.writestr("assets/source.txt", b"source")
                archive.writestr("assets/dexopt/baseline.prof", compiled.read_bytes())
            with zipfile.ZipFile(apk) as archive:
                report = payload.verify_source_assets(archive, root)
                self.assertEqual(len(report["compilerGeneratedArtProfiles"]), 1)
                compiled.write_bytes(b"pro\x00015\x00different compilation")
                with self.assertRaisesRegex(ValueError, "this Gradle compiler output"):
                    payload.verify_source_assets(archive, root)
            with zipfile.ZipFile(apk, "a") as archive:
                archive.writestr("assets/dexopt/extra.bin", b"unlisted")
            with zipfile.ZipFile(apk) as archive, self.assertRaisesRegex(ValueError, "inventory differs"):
                payload.verify_source_assets(archive, root)

    def test_production_identity_rejects_preview_debuggable_and_wrong_sdk(self):
        valid = "package: name='ru.tropa.app' versionCode='14' versionName='0.4.31'\nsdkVersion:'26'\ntargetSdkVersion:'36'\n"
        self.assertEqual(MODULE.production_badging(valid, "0.4.31", 14)["applicationId"], "ru.tropa.app")
        for invalid in (valid.replace("ru.tropa.app'", "ru.tropa.app.preview'"),
                        valid + "application-debuggable\n", valid.replace("'36'", "'35'"),
                        valid.replace("'0.4.31'", "'0.4.31-preview'"), valid.replace("'14'", "'13'")):
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                MODULE.production_badging(invalid, "0.4.31", 14)

    def test_pinned_certificate_rejects_debug_key_rotation_multiple_signers_and_no_v2(self):
        valid = f"Signer #1 certificate DN: CN=Tropnik Release\nSigner #1 certificate SHA-256 digest: {DIGEST}\nVerified using v2 scheme (APK Signature Scheme v2): true\n"
        self.assertEqual(MODULE.production_certificate(valid, DIGEST), DIGEST)
        for invalid in (valid.replace("Tropnik Release", "Android Debug"),
                        valid.replace(DIGEST, "cd" * 32), valid + f"Signer #2 certificate SHA-256 digest: {DIGEST}\n",
                        valid.replace(": true", ": false")):
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                MODULE.production_certificate(invalid, DIGEST)

    def test_unsigned_mode_refuses_any_production_secret(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(MODULE.preflight(Path("."), True))
            for name in MODULE.SIGNING_NAMES:
                with patch.dict(os.environ, {name: "fixture-only"}), self.assertRaises(ValueError):
                    MODULE.preflight(Path("."), True)

    def test_external_key_requires_private_file_independent_fingerprint_and_https_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repository"
            root.mkdir()
            key = base / "operator.jks"
            key.write_bytes(b"fixture metadata only, not a private key")
            key.chmod(0o600)
            env = dict(zip(MODULE.SIGNING_NAMES, (str(key), "fixture-password", "owner-release", "fixture-key-password", DIGEST)))
            env["TROPA_API_BASE_URL"] = "https://api.example.invalid"
            self.assertEqual(MODULE.signing_inputs(env, root), (key, "owner-release", DIGEST))
            for field, value in (("TROPNIK_RELEASE_CERT_SHA256", ""), ("TROPNIK_RELEASE_CERT_SHA256", "not-a-sha"),
                                 ("TROPNIK_RELEASE_KEY_ALIAS", "AndroidDebugKey"), ("TROPA_API_BASE_URL", ""),
                                 ("TROPA_API_BASE_URL", "http://api.example.invalid"),
                                 ("TROPA_API_BASE_URL", "https://secret@example.invalid")):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    MODULE.signing_inputs({**env, field: value}, root)
            key.chmod(0o644)
            with self.assertRaises(ValueError):
                MODULE.signing_inputs(env, root)
            key.chmod(0o600)
            linked = base / "linked.jks"
            linked.symlink_to(key)
            with self.assertRaises(ValueError):
                MODULE.signing_inputs({**env, "TROPNIK_RELEASE_KEYSTORE": str(linked)}, root)
            key.rename(root / "private.jks")
            with self.assertRaises(ValueError):
                MODULE.signing_inputs({**env, "TROPNIK_RELEASE_KEYSTORE": str(root / "private.jks")}, root)

    def test_preflight_compares_real_certificate_bytes_and_hides_tool_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repository"
            root.mkdir()
            key = base / "operator.jks"
            key.write_bytes(b"fixture only")
            key.chmod(0o600)
            env = dict(zip(MODULE.SIGNING_NAMES, (str(key), "fixture-password", "owner-release", "fixture-key-password", DIGEST)))
            env["TROPA_API_BASE_URL"] = "https://api.example.invalid"
            result = MODULE.subprocess.CompletedProcess([], 1, b"", b"provider emitted fixture-password")
            with patch.dict(os.environ, env, clear=True), patch.object(MODULE.subprocess, "run", return_value=result) as run:
                with self.assertRaises(ValueError) as raised:
                    MODULE.preflight(root, False)
                self.assertNotIn("fixture-password", str(raised.exception))
                self.assertIn("-storepass:env", run.call_args.args[0])
                self.assertNotIn("fixture-password", run.call_args.args[0])
                result.returncode, result.stdout = 0, b"wrong certificate bytes"
                with self.assertRaisesRegex(ValueError, "differs"):
                    MODULE.preflight(root, False)


if __name__ == "__main__":
    unittest.main()
