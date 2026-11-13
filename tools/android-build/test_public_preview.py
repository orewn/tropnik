"""Reject mismatched public releases and universal manifests without network."""
from __future__ import annotations
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("public_preview_verifier", HERE / "verify-public-preview.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class Response(io.BytesIO):
    status = 200
    def __init__(self, value, length=None):
        super().__init__(value)
        self.headers = {} if length is None else {"Content-Length": length}


def metadata_fixture():
    universal = {"bytes": 200, "sha256": "a" * 64}
    arm64 = {"bytes": 100, "sha256": "b" * 64}
    build = {"sourceCommit": "c" * 40, "workflowRunId": "123", "signingCertificateSha256": "d" * 64, "applicationId": verifier.APP_ID,
             "files": {verifier.UNIVERSAL: universal, verifier.ARM64: arm64},
             "mapRuntime": {"mapRenderer": "tropnik-canvas", "mapRendererSharedWithWeb": True}}
    metadata = {"architecture": "arm64-v8a", **arm64, "sourceCommit": build["sourceCommit"], "applicationId": verifier.APP_ID,
                "workflowRunId": 123, "signingCertificateSha256": build["signingCertificateSha256"],
                "signature": "development / debug", "compatibleWithPreviousPreview": False,
                "version": "0.4.24-preview", "versionCode": 12, "minSdk": 26, "targetSdk": 36}
    verification = {"sha256": universal["sha256"], "sizeBytes": universal["bytes"],
                    "abis": ["arm64-v8a", "armeabi-v7a", "x86_64"]}
    for index, (destination, source) in enumerate(verifier.SHARED_FIELDS.items()):
        value = [513, 513] if destination == "sceneGridDimensions" else ("e" * 64 if "Sha256" in destination else index + 1)
        metadata[destination] = value
        verification[source] = copy.deepcopy(value)
    device = {"tests": len(verifier.instrumentation.EXPECTED), "testedArtifact": verifier.UNIVERSAL, "testedArchitecture": "x86_64",
              "testedApks": {verifier.UNIVERSAL: copy.deepcopy(universal)},
              "deviceExecutionVerified": True, "releasePayloadDeviceVerified": True,
              "installedArtifactBytesVerified": True, "physicalDeviceVerified": False,
              "arm64DeviceExecutionVerified": False, "environment": "recorded emulator fixture",
              "graphicsDriver": {"verified": True, "mode": "swangle"}}
    return metadata, build, device, verification


class PublicPreviewTest(unittest.TestCase):
    def test_public_stream_requires_the_complete_exact_bytes(self):
        value = b"actual bounded release bytes"
        expected = {"bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}
        self.assertEqual(verifier.hash_response(Response(value), expected),
                         {**expected, "anonymous": True})
        for payload, length in ((value[:-1], None), (value + b"x", None),
                                (b"x" * len(value), None), (value, "999"), (value, "invalid")):
            with self.subTest(payload=payload, length=length), self.assertRaises(ValueError):
                verifier.hash_response(Response(payload, length), expected)
        response = Response(value)
        response.status = 404
        with self.assertRaises(ValueError):
            verifier.hash_response(response, expected)

    def test_redirects_cannot_change_to_an_untrusted_or_authenticated_origin(self):
        for host in verifier.PUBLIC_HOSTS:
            self.assertEqual(verifier.public_url("https://" + host + "/asset"), "https://" + host + "/asset")
        for url in ("http://github.com/asset", "https://example.com/asset",
                    "https://user:secret@github.com/asset", "https://github.com:443/asset",
                    "https://github.com.evil.example/asset"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                verifier.public_url(url)

    def test_public_release_requires_exact_tag_body_and_every_asset_digest(self):
        publication = {"tag": "v0.4.24-preview", "name": "Preview fixture", "sourceCommit": "a" * 40,
                       "assets": [{"name": "asset-" + str(i), "bytes": i + 1, "sha256": str(i) * 64}
                                  for i in range(6)]}
        remote = {"draft": False, "prerelease": True, "tag_name": publication["tag"],
                  "name": publication["name"], "body": "exact body",
                  "assets": [{"name": item["name"], "state": "uploaded", "size": item["bytes"],
                              "digest": "sha256:" + item["sha256"]} for item in publication["assets"]]}
        tag = {"ref": "refs/tags/" + publication["tag"], "object": {"type": "commit", "sha": publication["sourceCommit"]}}
        verifier.validate_public_release(remote, tag, publication, "exact body")
        mutations = (
            lambda r, t: r.update(draft=True), lambda r, t: r.update(prerelease=False),
            lambda r, t: r.update(tag_name="v0.4.23-preview"), lambda r, t: r.update(name="other"),
            lambda r, t: r.update(body="other"), lambda r, t: t["object"].update(sha="b" * 40),
            lambda r, t: t["object"].update(type="tag"), lambda r, t: t.update(ref="refs/tags/other"),
            lambda r, t: r["assets"].pop(), lambda r, t: r["assets"].append(copy.deepcopy(r["assets"][0])),
            lambda r, t: r["assets"][0].update(size=999),
            lambda r, t: r["assets"][0].update(digest="sha256:" + "f" * 64),
            lambda r, t: r["assets"][0].update(state="new"),
        )
        for mutate in mutations:
            changed, changed_tag = copy.deepcopy(remote), copy.deepcopy(tag)
            mutate(changed, changed_tag)
            with self.assertRaises(ValueError):
                verifier.validate_public_release(changed, changed_tag, publication, "exact body")

    def test_universal_mapping_preserves_the_producer_and_uses_only_verified_universal_fields(self):
        metadata, build, device, verification = metadata_fixture()
        before = copy.deepcopy(metadata)
        result = verifier.universal_metadata(metadata, build, device, verification, "f" * 64)
        self.assertEqual(metadata, before)
        self.assertEqual(result["architecture"], "universal")
        self.assertEqual(result["sha256"], build["files"][verifier.UNIVERSAL]["sha256"])
        self.assertEqual(result["bytes"], 200)
        self.assertEqual(result["testedUniversalSha256"], result["sha256"])
        self.assertEqual(result["deviceTestCount"], len(verifier.instrumentation.EXPECTED))
        self.assertTrue(result["deviceExecutionVerified"])
        self.assertFalse(result["physicalDeviceVerified"])
        self.assertFalse(result["arm64DeviceExecutionVerified"])
        self.assertFalse(result["compatibleWithPreviousPreview"])
        self.assertEqual(result["buildReceiptSha256"], "f" * 64)
        mutations = (
            lambda m, b, d, v: m.update(architecture="universal"),
            lambda m, b, d, v: m.update(sourceCommit="f" * 40),
            lambda m, b, d, v: m.update(signingCertificateSha256="f" * 64),
            lambda m, b, d, v: m.update(compatibleWithPreviousPreview=True),
            lambda m, b, d, v: m.update(applicationId="ru.tropa.app"),
            lambda m, b, d, v: v.update(abis=["arm64-v8a"]),
            lambda m, b, d, v: v.update(sha256="f" * 64),
            lambda m, b, d, v: v.update(sizeBytes=201),
            lambda m, b, d, v: v.update(catalogGeometryFilesVerified=999),
            lambda m, b, d, v: d.update(tests=len(verifier.instrumentation.EXPECTED) - 1),
            lambda m, b, d, v: d.update(tests=len(verifier.instrumentation.EXPECTED) + 1),
            lambda m, b, d, v: d.update(testedArchitecture="arm64-v8a"),
            lambda m, b, d, v: d.update(deviceExecutionVerified=False),
            lambda m, b, d, v: d.update(physicalDeviceVerified=True),
            lambda m, b, d, v: d["testedApks"][verifier.UNIVERSAL].update(sha256="f" * 64),
        )
        for mutate in mutations:
            values = metadata_fixture()
            mutate(*values)
            with self.assertRaises(ValueError):
                verifier.universal_metadata(*values, "f" * 64)


class PreviousPreviewIdentityTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "-q")
        gradle = self.root / "android/app/build.gradle.kts"
        gradle.parent.mkdir(parents=True)
        gradle.write_text('applicationId = "ru.tropa.app.preview"\nversionCode = 13\nversionName = "0.4.25-preview"\n')
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Previous APK source")
        source = self.git("rev-parse", "HEAD").strip()
        self.previous = {"sourceCommit": source, "version": "0.4.25-preview", "versionCode": 13,
                         "sha256": "a" * 64, "signingCertificateSha256": "b" * 64, "signature": "development / debug"}
        self.path = self.root / verifier.PREVIOUS_MANIFEST
        self.path.parent.mkdir(parents=True)
        self.commit_manifest()
        self.build = {"applicationId": verifier.APP_ID, "versionCode": 14, "signingCertificateSha256": "c" * 64}

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True, stderr=subprocess.DEVNULL)

    def commit_manifest(self):
        self.path.write_text(json.dumps(self.previous))
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Published website baseline")

    def test_comparison_uses_the_committed_published_version_and_not_a_historical_constant(self):
        result = verifier.previous_preview_comparison(self.root, self.build)
        self.assertEqual(result["previousPreview"]["version"], "0.4.25-preview")
        self.assertEqual(result["previousSigningCertificateSha256"], "b" * 64)
        self.assertTrue(result["sameApplicationIdAsPreviousPreview"])
        self.assertTrue(result["versionCodeIncreases"])
        self.assertFalse(result["sameCertificateAsPreviousPreview"])
        self.assertFalse(result["updateIdentityRequirementsMet"])
        self.assertFalse(result["updateInstallCompatibilityVerified"])
        self.assertEqual(result["updateCompatibilityAssessment"], "signing-certificate-mismatch")

    def test_matching_signer_never_proves_upgrade_or_accepts_a_downgrade(self):
        build = {**self.build, "signingCertificateSha256": self.previous["signingCertificateSha256"]}
        result = verifier.previous_preview_comparison(self.root, build)
        self.assertTrue(result["updateIdentityRequirementsMet"])
        self.assertFalse(result["updateInstallCompatibilityVerified"])
        self.assertEqual(result["updateCompatibilityAssessment"], "identity-matches-upgrade-not-tested")
        for code in (12, 13):
            result = verifier.previous_preview_comparison(self.root, {**build, "versionCode": code})
            self.assertFalse(result["updateIdentityRequirementsMet"])
            self.assertEqual(result["updateCompatibilityAssessment"], "non-increasing-version-code")

    def test_uncommitted_or_wrong_source_baselines_fail_closed(self):
        self.path.write_text(json.dumps({**self.previous, "signingCertificateSha256": "e" * 64}))
        with self.assertRaisesRegex(ValueError, "differs from the held source commit"):
            verifier.previous_preview_comparison(self.root, self.build)
        self.previous["versionCode"] = 99
        self.commit_manifest()
        with self.assertRaisesRegex(ValueError, "differs from its own source commit"):
            verifier.previous_preview_comparison(self.root, self.build)


if __name__ == "__main__":
    unittest.main()
