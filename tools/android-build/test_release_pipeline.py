"""Fail-closed release/provenance regressions; no SDK or network mutations."""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import preview_artifacts as artifacts

HERE = Path(__file__).resolve().parent

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

checker = module("instrumentation_check", "check-instrumentation.py")
release = module("preview_release", "release-preview.py")


def raw_results(names=None, result=0, final=-1):
    names = sorted(checker.EXPECTED) if names is None else names
    lines = []
    for index, name in enumerate(names, 1):
        for code in (1, result):
            lines += [f"INSTRUMENTATION_STATUS: class={checker.CLASS_NAME}",
                      f"INSTRUMENTATION_STATUS: test={name}",
                      "INSTRUMENTATION_STATUS: id=AndroidJUnitRunner",
                      f"INSTRUMENTATION_STATUS: numtests={len(checker.EXPECTED)}",
                      f"INSTRUMENTATION_STATUS: current={index}",
                      "INSTRUMENTATION_STATUS: stream=.",
                      f"INSTRUMENTATION_STATUS_CODE: {code}"]
    if final is not None:
        lines += ["INSTRUMENTATION_RESULT: stream=", f"OK ({len(checker.EXPECTED)} tests)", f"INSTRUMENTATION_CODE: {final}"]
    return "\n".join(lines) + "\n"


class RawResultsTest(unittest.TestCase):
    def test_all_required_start_completion_pairs_pass(self):
        result = checker.inspect_raw(raw_results(), 0)
        self.assertTrue(result["deviceExecutionVerified"])
        self.assertEqual(result["tests"], len(checker.EXPECTED))

    def test_process_success_alone_never_means_test_success(self):
        bad = ["", "OK (6 tests)\nINSTRUMENTATION_CODE: -1\n",
               raw_results(result=-2), raw_results(result=-1), raw_results(result=-3), raw_results(result=-4),
               raw_results(final=None), raw_results(final=0), raw_results() + "INSTRUMENTATION_CODE: -1\n",
               raw_results() + "INSTRUMENTATION_FAILED: crashed\n",
               raw_results() + "INSTRUMENTATION_RESULT: shortMsg=Process crashed\n"]
        for value in bad:
            with self.subTest(value=value[-60:]):
                self.assertFalse(checker.inspect_raw(value, 0)["deviceExecutionVerified"])
        self.assertFalse(checker.inspect_raw(raw_results(), 124)["deviceExecutionVerified"])

    def test_missing_duplicate_foreign_and_truncated_cases_fail(self):
        names = sorted(checker.EXPECTED)
        bad = [raw_results(names[:-1]), raw_results(names + [names[0]]),
               raw_results(names[:-1] + [names[0]]), raw_results().replace(checker.CLASS_NAME, "another.Class"),
               raw_results().replace(f"numtests={len(checker.EXPECTED)}", "numtests=1"),
               raw_results().replace("INSTRUMENTATION_STATUS_CODE: 1\n", "", 1),
               raw_results() + "INSTRUMENTATION_STATUS: class=truncated\n"]
        for value in bad:
            self.assertFalse(checker.inspect_raw(value, 0)["deviceExecutionVerified"])


class ReleaseFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root, self.dist, self.device = (self.base / name for name in ("source", "dist", "device"))
        for path in (self.root, self.dist, self.device):
            path.mkdir()
        (self.root / "android/app").mkdir(parents=True)
        (self.root / "android/app/build.gradle.kts").write_text('versionName = "0.4.16-preview"\nversionCode = 8\n')
        self.request = {"schemaVersion": 1, "requestId": "android-preview-fixture-request", "version": "0.4.16-preview", "versionCode": 8,
                        "notesFile": "tools/android-build/release-notes/0.4.16-preview.md"}
        (self.root / self.request["notesFile"]).parent.mkdir(parents=True)
        (self.root / self.request["notesFile"]).write_text("Browser planner; development preview.\n")
        self.json(self.root / release.REQUEST, self.request)
        def git(*args):
            return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.DEVNULL, text=True).strip()
        self.git = git
        git("init", "--initial-branch=main")
        git("add", ".")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture source")
        self.commit = git("rev-parse", "HEAD")
        self.env = {"GITHUB_SHA": self.commit, "GITHUB_RUN_ID": "12345", "GITHUB_RUN_ATTEMPT": "1",
                    "GITHUB_REPOSITORY": "orewn/tropnik", "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "push"}
        self.environment = patch.dict(os.environ, self.env)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        cert = "ab" * 32
        for name in artifacts.APK_NAMES:
            (self.dist / name).write_bytes((name + " exact APK fixture").encode())
            stem = name.removesuffix(".apk")
            (self.dist / (stem + ".signature.txt")).write_text(
                "Verified using v2 scheme (APK Signature Scheme v2): true\n"
                "Signer #1 certificate DN: C=US, O=Android, CN=Android Debug\n"
                f"Signer #1 certificate SHA-256 digest: {cert}\n")
            package = artifacts.TEST_ID if name == artifacts.TEST_APK else artifacts.APP_ID
            version, code = ("", "") if name == artifacts.TEST_APK else ("0.4.16-preview", "8")
            (self.dist / (stem + ".manifest.txt")).write_text(
                f"package: name='{package}' versionCode='{code}' versionName='{version}' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'\n")
            if name == artifacts.TEST_APK:
                continue
            fp = artifacts.fingerprint(self.dist / name)
            self.json(self.dist / (stem + ".compression.json"), {
                "outputSha256": fp["sha256"], "outputBytes": fp["bytes"], "debugCertificateSha256": cert,
                **{key: True for key in ("allUncompressedEntrySha256Unchanged", "sameDebugCertificateVerified",
                                        "zipAlignment16KVerified", "apkV2SignatureVerified")}})
            self.json(self.dist / (stem + ".verification.json"), {
                "sha256": fp["sha256"], "sizeBytes": fp["bytes"],
                "abis": ["arm64-v8a"] if name == artifacts.ARM64 else ["arm64-v8a", "armeabi-v7a", "x86_64"],
                "russiaDisplayProvenanceSha256": "cd" * 32, "landscapeGridDimensions": [513, 513],
                "russiaOverviewTileCount": 341, "russiaOverviewManifestSha256": "ef" * 32,
                "catalogReferenceRouteCount": 306, "catalogRegionCount": 15, "catalogLearningRouteCount": 1,
                "catalogReferenceOnlyRouteCount": 29, "catalogSha256": "12" * 32,
                "catalogManifestSha256": "34" * 32, "catalogGeometryFilesVerified": 277})
            (self.dist / (stem + ".alignment.txt")).write_text("Verification successful\n")
        self.json(self.dist / "unit-tests.json", {"tests": 40, "failures": 0, "errors": 0, "skipped": 0})
        self.build = artifacts.build_receipt(self.dist, self.root)
        self.json(self.device / "installed-apks.json", {
            "schemaVersion": 1, "sourceCommit": self.commit, "workflowRunId": "12345",
            "buildReceiptSha256": artifacts.fingerprint(self.dist / artifacts.RECEIPT)["sha256"],
            "installedArtifactBytesVerified": True,
            "installedApks": {name: self.build["files"][name] for name in (artifacts.UNIVERSAL, artifacts.TEST_APK)}})
        raw = raw_results()
        (self.device / "raw-instrumentation.log").write_text(raw)
        (self.device / "graphics-driver.txt").write_text("GLES: Google, ANGLE (Google, SwiftShader Device (Subzero), Vulkan 1.3.0), OpenGL ES 3.0\n")
        device = checker.bind_artifact(checker.inspect_raw(raw, 0), self.dist, self.root, self.device / "installed-apks.json")
        self.json(self.device / "device-result.json", device)
        checker.write_junit(device, self.device / "TEST-LocalExperienceTest.xml")
        (self.device / "tested-apks.sha256").write_text("fixture recorded APK checksums\n")

    @staticmethod
    def json(path, obj):
        path.write_text(json.dumps(obj, indent=2) + "\n")

    def test_artifact_change_foreign_run_or_source_version_fail(self):
        original = (self.dist / artifacts.UNIVERSAL).read_bytes()
        (self.dist / artifacts.UNIVERSAL).write_bytes(original + b"tamper")
        with self.assertRaises(ValueError):
            artifacts.verify_receipt(self.dist, self.root)
        (self.dist / artifacts.UNIVERSAL).write_bytes(original)
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "999"}), self.assertRaises(ValueError):
            artifacts.verify_receipt(self.dist, self.root)
        (self.root / "android/app/build.gradle.kts").write_text('versionName = "0.4.17-preview"\nversionCode = 9\n')
        with self.assertRaises(ValueError):
            artifacts.verify_receipt(self.dist, self.root)

    def test_mismatched_test_signature_is_rejected(self):
        path = self.dist / "tropnik-instrumentation-tests.signature.txt"
        path.write_text(path.read_text().replace("ab" * 32, "cd" * 32))
        with self.assertRaises(ValueError):
            artifacts.build_receipt(self.dist, self.root)

    def test_dirty_source_without_a_version_change_cannot_create_or_reuse_a_ci_receipt(self):
        receipt = (self.dist / artifacts.RECEIPT).read_bytes()
        source = self.root / "android/app/build.gradle.kts"
        source.write_text(source.read_text() + "// Uncommitted change after checkout\n")
        with self.assertRaisesRegex(ValueError, "inputs differ"):
            artifacts.build_receipt(self.dist, self.root)
        self.assertEqual((self.dist / artifacts.RECEIPT).read_bytes(), receipt)
        with self.assertRaisesRegex(ValueError, "inputs differ"):
            artifacts.verify_receipt(self.dist, self.root)

    def test_missing_or_legacy_graphics_driver_cannot_be_device_verified(self):
        path = self.device / "graphics-driver.txt"
        for text in ("", "GLES: Google, Android Emulator OpenGL ES Translator (Google SwiftShader), OpenGL ES 3.0\n",
                     "Requested mode: swangle\nGLES: Google SwiftShader\n"):
            path.write_text(text)
            with self.assertRaises(ValueError):
                checker.bind_artifact(checker.inspect_raw(raw_results(), 0), self.dist, self.root, self.device / "installed-apks.json")
        path.unlink()
        with self.assertRaises(ValueError):
            checker.bind_artifact(checker.inspect_raw(raw_results(), 0), self.dist, self.root, self.device / "installed-apks.json")

    def test_real_unversioned_instrumentation_badging_does_not_relax_app_checks(self):
        # Exact first-line shape produced by AGP/AAPT2 in run 42641770635.
        manifest = (self.dist / "tropnik-instrumentation-tests.manifest.txt").read_text()
        self.assertIsNone(artifacts.parse_badging(manifest, allow_unversioned=True)["versionCode"])
        self.assertEqual(artifacts.verify_receipt(self.dist, self.root)["versionCode"], 8)
        for name in (artifacts.ARM64, artifacts.UNIVERSAL):
            path = self.dist / (name.removesuffix(".apk") + ".manifest.txt")
            original = path.read_text()
            for changed in (original.replace("versionCode='8'", "versionCode=''"),
                            original.replace("versionName='0.4.16-preview'", "versionName=''"),
                            original.replace("versionCode='8'", "versionCode='7'")):
                path.write_text(changed)
                with self.assertRaises(ValueError):
                    artifacts.inspect_payload(self.dist, self.root)
            path.write_text(original)
        test_path = self.dist / "tropnik-instrumentation-tests.manifest.txt"
        test_path.write_text(manifest.replace(artifacts.TEST_ID, "foreign.test"))
        with self.assertRaises(ValueError):
            artifacts.inspect_payload(self.dist, self.root)
        test_path.write_text(manifest + "instrumentation: name='foreign.Runner' targetPackage='ru.tropa.app.preview'\n")
        with self.assertRaises(ValueError):
            artifacts.inspect_payload(self.dist, self.root)

    def test_device_proof_cannot_be_reused_for_another_apk_or_source(self):
        original = json.loads((self.device / "device-result.json").read_text())
        for mutation in (lambda x: x.update(sourceCommit="0" * 40),
                         lambda x: x["testedApks"][artifacts.UNIVERSAL].update(sha256="0" * 64),
                         lambda x: x.update(tests=5), lambda x: x["cases"].pop(),
                         lambda x: x.update(arm64DeviceExecutionVerified=True),
                         lambda x: x.update(releasePayloadDeviceVerified=False)):
            value = copy.deepcopy(original)
            mutation(value)
            with self.assertRaises(ValueError):
                release.validate_device(value, self.build, self.dist)

    def test_release_request_only_changes_or_explicit_main_dispatch(self):
        self.assertTrue(release.is_requested(self.root, "push", "refs/heads/main", "0" * 40, False))
        self.assertFalse(release.is_requested(self.root, "push", "refs/heads/main", self.commit, False))
        self.assertFalse(release.is_requested(self.root, "pull_request", "refs/heads/main", "", True))
        self.assertFalse(release.is_requested(self.root, "workflow_dispatch", "refs/heads/topic", "", True))
        self.assertFalse(release.is_requested(self.root, "workflow_dispatch", "refs/heads/main", "", False))
        self.assertTrue(release.is_requested(self.root, "workflow_dispatch", "refs/heads/main", "", True))
        self.request["versionCode"] = 9
        self.json(self.root / release.REQUEST, self.request)
        with self.assertRaises(ValueError):
            release.prepare(self.root, self.dist, self.device, self.base / "bad")

    def test_retry_request_id_is_explicit_validated_and_changes_the_gate(self):
        self.request["requestId"] = "android-preview-instrumentation-metadata-fix"
        self.json(self.root / release.REQUEST, self.request)
        self.git("add", release.REQUEST)
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Explicit release retry")
        self.assertTrue(release.is_requested(self.root, "push", "refs/heads/main", self.commit, False))
        self.assertEqual(release.read_request(self.root)["requestId"], self.request["requestId"])
        for invalid in ("", " ", "../other", "A" * 100, None):
            self.request["requestId"] = invalid
            self.json(self.root / release.REQUEST, self.request)
            with self.assertRaises(ValueError):
                release.read_request(self.root)

    def test_prepared_release_is_reproducible_and_arm64_not_device_claimed(self):
        first = release.prepare(self.root, self.dist, self.device, self.base / "one")
        second = release.prepare(self.root, self.dist, self.device, self.base / "two")
        self.assertEqual(first, second)
        self.assertEqual(len(first["assets"]), 6)
        metadata = json.loads((self.base / "one/android-manifest.json").read_text())
        self.assertFalse(metadata["deviceExecutionVerified"])
        self.assertFalse(metadata["releasePayloadDeviceVerified"])
        self.assertTrue(metadata["universalReleasePayloadDeviceVerified"])
        self.assertFalse(metadata["compatibleWithPreviousPreview"])
        self.assertEqual(metadata["plannerMode"], "browser")

    def test_missing_or_forged_raw_proof_prevents_preparation(self):
        (self.device / "raw-instrumentation.log").write_text("OK (6 tests)\nINSTRUMENTATION_CODE: -1\n")
        with self.assertRaises(ValueError):
            release.prepare(self.root, self.dist, self.device, self.base / "bad")

    def test_changed_observed_graphics_driver_prevents_preparation(self):
        path = self.device / "graphics-driver.txt"
        path.write_text(path.read_text().replace("Vulkan 1.3.0", "Vulkan 1.3.1"))
        self.assertTrue(checker.graphics_driver(path)["verified"])
        with self.assertRaisesRegex(ValueError, "graphics proof differs"):
            release.prepare(self.root, self.dist, self.device, self.base / "bad")

    def test_existing_tag_or_changed_published_asset_never_writes(self):
        output = self.base / "candidate"
        publication = release.prepare(self.root, self.dist, self.device, output)
        class ExistingTag:
            calls = []
            def request(self, method, path, **kwargs):
                self.calls.append(method)
                if "/releases?" in path:
                    return []
                return {"object": {"sha": "0" * 40}} if "/git/ref/" in path else None
        client = ExistingTag()
        with self.assertRaises(ValueError):
            release.publish(output, client)
        self.assertEqual(set(client.calls), {"GET"})
        assets = [{"name": item["name"], "size": item["bytes"], "state": "uploaded", "digest": "sha256:" + item["sha256"]} for item in publication["assets"]]
        release.verify_remote_assets({"assets": assets}, publication)
        assets[0]["digest"] = "sha256:" + "0" * 64
        with self.assertRaises(ValueError):
            release.verify_remote_assets({"assets": assets}, publication)

    def test_publisher_stages_all_verified_assets_before_publication(self):
        output = self.base / "candidate"
        release.prepare(self.root, self.dist, self.device, output)
        class API:
            def __init__(self):
                self.calls, self.assets, self.published = [], [], False
            def request(self, method, path, data=None, content_type=None, missing_ok=False):
                self.calls.append((method, path))
                if "/git/ref/" in path:
                    return {"object": {"sha": os.environ["GITHUB_SHA"]}} if self.published else None
                if "/releases/tags/" in path:
                    return None
                if "/releases?" in path:
                    return []
                if method == "POST" and "/assets?" in path:
                    name = path.split("name=")[1]
                    asset = {"name": name, "state": "uploaded", "size": len(data), "digest": "sha256:" + hashlib.sha256(data).hexdigest()}
                    self.assets.append(asset)
                    return asset
                if method == "PATCH":
                    self.published = True
                return {"id": 10, "tag_name": "v0.4.16-preview", "draft": not self.published, "prerelease": True,
                        "assets": self.assets, "html_url": "https://github.com/orewn/tropnik/releases/tag/v0.4.16-preview"}
        client = API()
        result = release.publish(output, client)
        self.assertEqual(result["status"], "published")
        patch_index = next(i for i, call in enumerate(client.calls) if call[0] == "PATCH")
        self.assertEqual(sum(call[0] == "POST" and "/assets?" in call[1] for call in client.calls[:patch_index]), 6)
        self.assertFalse(any(call[0] == "DELETE" for call in client.calls))

    def test_exact_partial_draft_resumes_only_missing_assets(self):
        output = self.base / "candidate"
        publication = release.prepare(self.root, self.dist, self.device, output)
        first = publication["assets"][0]
        class API:
            def __init__(self):
                self.calls, self.published = [], False
                self.assets = [{"name": first["name"], "size": first["bytes"], "state": "uploaded", "digest": "sha256:" + first["sha256"]}]
            def current(self):
                return {"id": 10, "tag_name": publication["tag"], "target_commitish": publication["sourceCommit"],
                        "name": publication["name"], "body": (output / "release-body.md").read_text(),
                        "draft": not self.published, "prerelease": True, "assets": self.assets,
                        "html_url": "https://github.com/orewn/tropnik/releases/tag/" + publication["tag"]}
            def request(self, method, path, data=None, content_type=None, missing_ok=False):
                self.calls.append((method, path))
                if "/git/ref/" in path:
                    return {"object": {"sha": publication["sourceCommit"]}} if self.published else None
                if method == "POST" and "/assets?" in path:
                    asset = {"name": path.split("name=")[1], "state": "uploaded", "size": len(data),
                             "digest": "sha256:" + hashlib.sha256(data).hexdigest()}
                    self.assets.append(asset)
                    return asset
                if method == "PATCH":
                    self.published = True
                return self.current()
        client = API()
        self.assertEqual(release.publish(output, client)["status"], "published")
        writes = [call for call in client.calls if call[0] == "POST"]
        self.assertEqual(len(writes), 5)
        self.assertTrue(all("/assets?" in path and not path.endswith(first["name"]) for method, path in writes))

    def test_partial_draft_mismatch_never_writes(self):
        output = self.base / "candidate"
        publication = release.prepare(self.root, self.dist, self.device, output)
        first = publication["assets"][0]
        correct = {"id": 10, "tag_name": publication["tag"], "target_commitish": publication["sourceCommit"],
                   "name": publication["name"], "body": (output / "release-body.md").read_text(), "draft": True,
                   "prerelease": True, "assets": [{"name": first["name"], "size": first["bytes"],
                   "state": "uploaded", "digest": "sha256:" + first["sha256"]}]}
        for change in (lambda x: x.update(target_commitish="main"), lambda x: x.update(body="another release"),
                       lambda x: x["assets"][0].update(digest="sha256:" + "0" * 64),
                       lambda x: x["assets"][0].update(state="starter"),
                       lambda x: x["assets"][0].update(name="unexpected.apk")):
            draft = copy.deepcopy(correct)
            change(draft)
            class API:
                calls = []
                def request(self, method, path, **kwargs):
                    self.calls.append(method)
                    return None if "/git/ref/" in path else draft
            client = API()
            with self.assertRaises(ValueError):
                release.publish(output, client)
            self.assertEqual(set(client.calls), {"GET"})

    def test_json_asset_upload_keeps_original_bytes(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'{"ok":true}'
        payload = b'{"version":"0.4.16-preview"}\n'
        with patch.object(release.urllib.request, "urlopen", return_value=Response()) as urlopen:
            release.GitHub("fixture-token").request("POST", "/repos/orewn/tropnik/releases/1/assets?name=android-manifest.json", payload, "application/json")
        self.assertEqual(urlopen.call_args.args[0].data, payload)


if __name__ == "__main__":
    unittest.main()
