"""Reject mismatched public releases and universal manifests without network."""
from __future__ import annotations
import copy
import hashlib
import importlib.util
import io
from pathlib import Path
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
    build = {"sourceCommit": "c" * 40, "workflowRunId": "123", "signingCertificateSha256": "d" * 64,
             "files": {verifier.UNIVERSAL: universal, verifier.ARM64: arm64},
             "mapRuntime": {"mapRenderer": "tropnik-canvas", "mapRendererSharedWithWeb": True}}
    metadata = {"architecture": "arm64-v8a", **arm64, "sourceCommit": build["sourceCommit"],
                "workflowRunId": 123, "signingCertificateSha256": build["signingCertificateSha256"],
                "signature": "development / debug", "compatibleWithPreviousPreview": False,
                "version": "0.4.24-preview", "versionCode": 12, "minSdk": 26, "targetSdk": 36}
    verification = {"sha256": universal["sha256"], "sizeBytes": universal["bytes"],
                    "abis": ["arm64-v8a", "armeabi-v7a", "x86_64"]}
    for index, (destination, source) in enumerate(verifier.SHARED_FIELDS.items()):
        value = [513, 513] if destination == "sceneGridDimensions" else ("e" * 64 if "Sha256" in destination else index + 1)
        metadata[destination] = value
        verification[source] = copy.deepcopy(value)
    device = {"tests": 8, "testedArtifact": verifier.UNIVERSAL, "testedArchitecture": "x86_64",
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
        self.assertEqual(result["deviceTestCount"], 8)
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
            lambda m, b, d, v: v.update(abis=["arm64-v8a"]),
            lambda m, b, d, v: v.update(sha256="f" * 64),
            lambda m, b, d, v: v.update(sizeBytes=201),
            lambda m, b, d, v: v.update(catalogGeometryFilesVerified=999),
            lambda m, b, d, v: d.update(tests=7),
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


if __name__ == "__main__":
    unittest.main()
