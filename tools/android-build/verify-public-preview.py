#!/usr/bin/env python3
"""Read-only, same-run proof of the published Android preview and site manifest.

Run after publish in the producer workflow. A failure does not undo publication
and must not be reported as a final release success. No GitHub writes occur.
"""
from __future__ import annotations
import sys
sys.dont_write_bytecode = True

import argparse
import copy
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

from preview_artifacts import (ARM64, RECEIPT, UNIVERSAL, fingerprint, read_json,
                               require, source_checkout, verify_sdk)

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("public_preview_release", HERE / "release-preview.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
PREVIOUS_CERTIFICATE = "a45e5fcbd9edcf0d1c4df1a8df7209b2417f13e7f95f64c36304ce4b9bd39dac"
PUBLIC_HOSTS = {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
SHARED_FIELDS = {
    "russiaCoverageProvenanceSha256": "russiaDisplayProvenanceSha256",
    "sceneGridDimensions": "landscapeGridDimensions",
    "localRouteGeometryCount": "catalogGeometryFilesVerified",
    **{key: key for key in ("russiaOverviewTileCount", "russiaOverviewManifestSha256",
                           "catalogReferenceRouteCount", "catalogRegionCount",
                           "catalogLearningRouteCount", "catalogReferenceOnlyRouteCount",
                           "catalogSha256", "catalogManifestSha256")},
}


def public_url(value):
    url = urllib.parse.urlsplit(value)
    require(url.scheme == "https" and url.hostname in PUBLIC_HOSTS and
            not url.username and not url.password and url.port is None,
            "Asset redirect left the anonymous public GitHub hosts")
    return value


class PublicRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 4
    def redirect_request(self, request, fp, code, message, headers, newurl):
        public_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


def anonymous_open(url, *, api=False):
    if api:
        require(url.startswith("https://api.github.com/repos/orewn/tropnik/"), "Unexpected public API URL")
    else:
        public_url(url)
    request = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json" if api else "application/octet-stream",
        "User-Agent": "tropnik-public-preview-verifier",
    }, method="GET")
    return urllib.request.build_opener(PublicRedirect()).open(request, timeout=30)


def public_json(url):
    with anonymous_open(url, api=True) as response:
        require(response.status == 200, "Public release metadata is unavailable")
        payload = response.read(2_000_001)
        require(len(payload) <= 2_000_000, "Oversized public release metadata")
        return json.loads(payload)


def hash_response(response, expected):
    require(response.status == 200, "Public asset is unavailable")
    length = response.headers.get("Content-Length")
    require(length is None or (length.isdigit() and int(length) == expected["bytes"]),
            "Public asset Content-Length differs")
    digest, count, started = hashlib.sha256(), 0, time.monotonic()
    while True:
        require(time.monotonic() - started <= 120, "Public asset verification timed out")
        chunk = response.read(min(1024 * 1024, expected["bytes"] + 1 - count))
        if not chunk:
            break
        count += len(chunk)
        require(count <= expected["bytes"], "Public asset exceeds expected size")
        digest.update(chunk)
    require(count == expected["bytes"] and digest.hexdigest() == expected["sha256"],
            "Public asset bytes or SHA256 differ")
    return {"bytes": count, "sha256": expected["sha256"], "anonymous": True}


def validate_public_release(remote, tag, publication, body):
    require(remote.get("draft") is False and remote.get("prerelease") is True and
            remote.get("tag_name") == publication["tag"] and
            remote.get("name") == publication["name"] and remote.get("body") == body,
            "Public release metadata differs from the prepared release")
    require(tag.get("ref") == "refs/tags/" + publication["tag"] and
            tag.get("object", {}).get("type") == "commit" and
            tag["object"].get("sha") == publication["sourceCommit"],
            "Public tag does not point at the exact tested source commit")
    release.verify_remote_assets(remote, publication)


def universal_metadata(metadata, build, device, verification, receipt_sha):
    universal, arm64 = build["files"][UNIVERSAL], build["files"][ARM64]
    require(metadata.get("architecture") == "arm64-v8a" and
            all(metadata.get(key) == arm64[key] for key in ("bytes", "sha256")) and
            metadata.get("sourceCommit") == build["sourceCommit"] and
            metadata.get("workflowRunId") == int(build["workflowRunId"]) and
            metadata.get("signingCertificateSha256") == build["signingCertificateSha256"] and
            metadata.get("signature") == "development / debug" and
            metadata.get("compatibleWithPreviousPreview") is False,
            "Producer ARM64 manifest differs from this build")
    require(verification.get("sha256") == universal["sha256"] and verification.get("sizeBytes") == universal["bytes"] and
            sorted(verification.get("abis", [])) == ["arm64-v8a", "armeabi-v7a", "x86_64"],
            "Universal verification differs from the exact three-ABI APK")
    require(device.get("tests") == 8 and device.get("testedArtifact") == UNIVERSAL and
            device.get("testedArchitecture") == "x86_64" and
            device.get("testedApks", {}).get(UNIVERSAL) == universal and
            all(device.get(key) is True for key in ("deviceExecutionVerified", "releasePayloadDeviceVerified", "installedArtifactBytesVerified")) and
            device.get("physicalDeviceVerified") is False and device.get("arm64DeviceExecutionVerified") is False,
            "Universal manifest requires all eight exact-artifact emulator cases")
    result = copy.deepcopy(metadata)
    for destination, source in SHARED_FIELDS.items():
        require(metadata.get(destination) == verification[source], "Universal payload metadata differs: " + destination)
        result[destination] = verification[source]
    result.update(build["mapRuntime"])
    result.update({"architecture": "universal", **universal, "abis": verification["abis"],
                   "testedArtifact": UNIVERSAL, "testedArchitecture": "x86_64",
                   "deviceExecutionVerified": True, "releasePayloadDeviceVerified": True,
                   "codeDeviceExecutionVerified": True, "universalReleasePayloadDeviceVerified": True,
                   "installedArtifactBytesVerified": True, "testedUniversalSha256": universal["sha256"],
                   "physicalDeviceVerified": False, "arm64DeviceExecutionVerified": False,
                   "deviceTestCount": device["tests"], "deviceTestEnvironment": device["environment"],
                   "buildReceiptSha256": receipt_sha, "graphicsDriver": device["graphicsDriver"],
                   "compatibleWithPreviousPreview": False})
    return result


def verify(args):
    root, directory, device_directory = args.root.resolve(), args.directory.resolve(), args.device_directory.resolve()
    require(os.environ.get("GITHUB_ACTIONS") == "true" and
            os.environ.get("GITHUB_REPOSITORY") == release.REPOSITORY and
            os.environ.get("GITHUB_REF") == "refs/heads/main",
            "This verifier must run in the original main producer workflow")
    commit = source_checkout(root, require_clean=True)
    build = verify_sdk(directory, root, args.sdk)
    require(build["sourceCommit"] == commit and build["workflowRunId"] == os.environ["GITHUB_RUN_ID"],
            "Producer workflow/source mismatch")
    for value in (args.build_artifact_id, args.device_artifact_id):
        require(re.fullmatch(r"[1-9][0-9]*", value or ""), "Missing exact producer artifact ID")
    with tempfile.TemporaryDirectory(prefix="tropnik-public-proof-") as temporary:
        prepared = Path(temporary) / "release"
        publication = release.prepare(root, directory, device_directory, prepared)
        expected_names = {ARM64, UNIVERSAL, "android-manifest.json", "verification-reports.zip",
                          "tropnik-" + build["version"] + "-source.tar.gz", "checksums.sha256"}
        require(len(publication["assets"]) == 6 and {item["name"] for item in publication["assets"]} == expected_names,
                "Expected all six exact prepared release assets")
        base = "https://api.github.com/repos/" + release.REPOSITORY
        remote = public_json(base + "/releases/tags/" + publication["tag"])
        tag = public_json(base + "/git/ref/tags/" + publication["tag"])
        validate_public_release(remote, tag, publication, (prepared / "release-body.md").read_text())
        device = read_json(device_directory / "device-result.json")
        universal = universal_metadata(read_json(prepared / "android-manifest.json"), build, device,
                                      read_json(directory / "tropnik-preview.verification.json"),
                                      fingerprint(directory / RECEIPT)["sha256"])
        # Reuse the existing manifest/anonymous APK validator; no cached local APK
        # can satisfy the mandatory public universal download.
        code = ("import {readFileSync} from 'node:fs';"
                "const m=JSON.parse(readFileSync(0,'utf8'));"
                "const api=await import(process.argv[1]);api.validateApkManifest(m);"
                "console.log(JSON.stringify(await api.verifyPublicApk(m)));")
        result = subprocess.run(["node", "--input-type=module", "-e", code,
                                 (root / "tools/pages-preview/apk-artifact.mjs").as_uri()],
                                input=json.dumps(universal), text=True, capture_output=True, check=False)
        require(result.returncode == 0, "Anonymous universal verification failed: " + result.stderr[-1500:])
        public_apk = json.loads(result.stdout)
        assets = []
        for item in publication["assets"]:
            if item["name"] == UNIVERSAL:
                require(public_apk["bytes"] == item["bytes"] and public_apk["sha256"] == item["sha256"] and
                        public_apk["source"] == "public-release", "Public universal proof differs")
                proof = {"bytes": public_apk["bytes"], "sha256": public_apk["sha256"], "anonymous": True}
            else:
                url = "https://github.com/" + release.REPOSITORY + "/releases/download/" + publication["tag"] + "/" + urllib.parse.quote(item["name"], safe="")
                with anonymous_open(url) as response:
                    proof = hash_response(response, item)
            assets.append({"name": item["name"], **proof})
        return universal, {
            "schemaVersion": 1, "scope": "published-universal-android-promotion", "verified": True,
            "sourceCommit": commit, "workflowRunId": int(build["workflowRunId"]),
            "buildArtifactId": int(args.build_artifact_id), "deviceArtifactId": int(args.device_artifact_id),
            "tag": publication["tag"], "releaseUrl": remote["html_url"], "anonymousAssetsVerified": 6, "assets": assets,
            "sourceArchiveRecreatedFromExactCommit": True, "releaseReportsRecreatedFromExactReceipts": True,
            "buildReceipt": fingerprint(directory / RECEIPT),
            "deviceEvidence": {name: fingerprint(device_directory / name) for name in
                               ("device-result.json", "installed-apks.json", "raw-instrumentation.log", "graphics-driver.txt")},
            "actualDeviceTests": device["tests"], "physicalDeviceVerified": False, "arm64DeviceExecutionVerified": False,
            "sdkSignaturesReverified": True, "productionSigned": False,
            "previousSigningCertificateSha256": PREVIOUS_CERTIFICATE,
            "signingCertificateSha256": build["signingCertificateSha256"],
            "sameCertificateAsPreviousPreview": build["signingCertificateSha256"] == PREVIOUS_CERTIFICATE,
            "updateInstallCompatibilityVerified": False, "pagesGateStillRequired": True,
            "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=HERE.parents[1])
    for name in ("directory", "device-directory", "output", "sdk"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("build-artifact-id", "device-artifact-id"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    require(not output.exists() and not any(output.is_relative_to(path.resolve()) for path in
            (args.root, args.directory, args.device_directory)), "Proof output must be new and outside source/input directories")
    output.mkdir(parents=True)
    try:
        manifest, proof = verify(args)
        for name, value in (("android-universal-manifest.json", manifest), ("public-release-verification.json", proof)):
            with (output / name).open("x") as stream:
                stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        # Both payloads contain only already-public release metadata and evidence.
        # Stable prefixes let a read-only connector recover them without ZIP extraction.
        print("TROPNIK_PUBLIC_UNIVERSAL_MANIFEST=" + json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
        print("TROPNIK_PUBLIC_RELEASE_PROOF=" + json.dumps(proof, ensure_ascii=False, separators=(",", ":")))
        print(json.dumps({"verified": True, "sourceCommit": proof["sourceCommit"], "anonymousAssetsVerified": 6,
                          "deviceTests": proof["actualDeviceTests"], "pagesGateStillRequired": True}))
    except Exception as error:
        (output / "public-release-failure.json").write_text(json.dumps({
            "verified": False, "publicationMayAlreadyExist": True, "finalReleaseConfirmed": False,
            "error": type(error).__name__ + ": " + str(error)}, ensure_ascii=False, indent=2) + "\n")
        raise


if __name__ == "__main__":
    main()
