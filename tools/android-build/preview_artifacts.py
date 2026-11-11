#!/usr/bin/env python3
"""Bind a preview, its test APK and verification reports to one build.

The receipt is provenance, not a replacement for SDK signature verification.
The device job verifies signatures again and installs these exact artifact bytes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

APP_ID = "ru.tropa.app.preview"
TEST_ID = APP_ID + ".test"
UNIVERSAL = "tropnik-preview.apk"
ARM64 = "tropnik-arm64-preview.apk"
TEST_APK = "tropnik-instrumentation-tests.apk"
RECEIPT = "preview-build.json"
APK_NAMES = (UNIVERSAL, ARM64, TEST_APK)
REPORT_NAMES = tuple(
    name.removesuffix(".apk") + suffix
    for name in APK_NAMES
    for suffix in (".signature.txt", ".manifest.txt")
) + tuple(
    name.removesuffix(".apk") + suffix
    for name in (UNIVERSAL, ARM64)
    for suffix in (".alignment.txt", ".compression.json", ".verification.json")
) + ("unit-tests.json",)
FILES = APK_NAMES + REPORT_NAMES
# Include native code, Gradle configuration, generators and all shared runtime
# data. Build/device/release report directories are outputs, not source inputs.
SOURCE_INPUTS = (
    "android/app", "android/gradle", "android/gradlew", "android/gradlew.bat",
    "android/build.gradle.kts", "android/settings.gradle.kts", "android/gradle.properties",
    "tools/android-build", "tools/map-package", "data/terrain-pilot/runtime", "data/pilot-map",
    "web/lib", "web/public/data", "web/public/maps", "web/public/offline-map",
    "web/public/terrain", "web/public/custom-map", "web/package.json", "web/pnpm-lock.yaml", "web/pnpm-workspace.yaml",
    "web/app/custom-map.css", "web/app/map-direction-marker.css", "web/app/map-detail.css",
    ".github/workflows/android.yml",
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def ci_build():
    return os.environ.get("GITHUB_ACTIONS") == "true" or any(
        os.environ.get(name) for name in ("GITHUB_SHA", "GITHUB_RUN_ID"))


def source_checkout(root: Path, *, require_clean=False):
    """Bind CI evidence to unchanged committed inputs, before and after build.

    Ignored Gradle/dependency outputs do not enter the source tree. Nonignored
    untracked code or runtime assets do: Gradle and the generators could consume
    them even though git archive of HEAD would not contain those bytes.
    """
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    expected = os.environ.get("GITHUB_SHA", "")
    require(not ci_build() or re.fullmatch(r"[a-f0-9]{40}", expected),
            "CI source verification requires a valid GITHUB_SHA")
    require(not expected or expected == commit, "Checkout commit differs from the workflow source")
    if require_clean or ci_build():
        changed = subprocess.check_output(
            ["git", "diff", "--no-ext-diff", "--name-only", "-z", "HEAD", "--", *SOURCE_INPUTS], cwd=root)
        untracked = subprocess.check_output(
            ["git", "ls-files", "--others", "--exclude-standard", "-z", "--", *SOURCE_INPUTS], cwd=root)
        require(not changed and not untracked,
                "Android build inputs differ from the source commit; regenerate and commit them before CI")
    return commit


def read_json(path: Path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 2_000_000,
            f"Missing, linked or oversized JSON: {path.name}")
    return json.loads(path.read_text())


def expected_map_runtime(root: Path):
    """Bind reports to the same reviewed runtime in both source targets."""
    native = root / "android/app/src/main/assets/custom-map/manifest.json"
    web = root / "web/public/custom-map/manifest.json"
    manifest = read_json(native)
    require(native.read_bytes() == web.read_bytes(), "Web and native map runtime manifests differ")
    require(manifest.get("schemaVersion") == 1 and manifest.get("runtime") == "tropnik-canvas"
            and manifest.get("bridge") == "exact-origin-web-message-port-v1", "Unknown shared map runtime")
    inputs = manifest.get("sourceInputs")
    require(isinstance(inputs, list) and 1 <= len(inputs) <= 256, "Shared map source inputs missing")
    encoded = (json.dumps(inputs, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode()
    require(hashlib.sha256(encoded).hexdigest() == manifest.get("sourceInputsSha256"), "Shared map source-input digest differs")
    seen = set()
    for record in inputs:
        path = record.get("path")
        require(isinstance(path, str) and re.fullmatch(r"[A-Za-z0-9_./-]+", path)
                and not path.startswith("/") and all(part not in ("", ".", "..") for part in path.split("/"))
                and path not in seen, "Unsafe or duplicate shared map input")
        seen.add(path)
        source = root / path
        require(source.is_file() and not source.is_symlink() and source.resolve().is_relative_to(root.resolve()), "Shared map source input is missing")
        data = source.read_bytes()
        require(len(data) == record.get("sizeBytes") and hashlib.sha256(data).hexdigest() == record.get("sha256"), "Shared map source input changed: " + path)
    files = manifest.get("files", [])
    workers = [record for record in files if record.get("path", "").startswith("workers/") and record.get("path", "").endswith(".js")]
    aliases = manifest.get("resourceAliases", [])
    require(5 <= len(files) <= 64 and 1 <= len(workers) <= 16 and 500 <= len(aliases) <= 2048, "Incomplete shared map runtime proof")
    return {"mapRenderer": "tropnik-canvas", "mapRendererManifestSha256": hashlib.sha256(native.read_bytes()).hexdigest(),
            "mapRendererSourceInputsSha256": manifest["sourceInputsSha256"], "mapRendererFilesVerified": len(files),
            "mapRendererWorkersVerified": len(workers), "mapRendererResourceAliasesVerified": len(aliases),
            "mapRendererNativeSdkRequired": False, "mapRendererSharedWithWeb": True,
            "mapRendererBridge": manifest["bridge"]}


def fingerprint(path: Path):
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= 150_000_000,
            f"Missing, linked or oversized artifact: {path.name}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def source_version(root: Path):
    text = (root / "android/app/build.gradle.kts").read_text()
    version = re.findall(r'^\s*versionName\s*=\s*"([^"]+)"\s*$', text, re.M)
    code = re.findall(r'^\s*versionCode\s*=\s*(\d+)\s*$', text, re.M)
    require(len(version) == len(code) == 1, "Android source must declare one version and code")
    require(re.fullmatch(r"\d+\.\d+\.\d+-preview", version[0]), "Only preview versions may use this pipeline")
    return version[0], int(code[0])


def parse_badging(text, *, allow_unversioned=False):
    # AAPT2 reports empty version fields for AGP's instrumentation APK. This
    # exception applies only to the test package; installable app versions stay
    # mandatory and are compared exactly with the checked-out Gradle source.
    match = re.search(r"^package: name='([^']+)' versionCode='(\d*)' versionName='([^']*)'", text, re.M)
    require(match is not None, "APK badging has no package/version")
    require(allow_unversioned or (bool(match[2]) and bool(match[3])), "Installable app APK requires a version and code")
    return {"applicationId": match[1], "versionCode": int(match[2]) if match[2] else None, "version": match[3]}


def certificate(text):
    hashes = re.findall(r"^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})$", text, re.M)
    require(len(hashes) == 1 and "CN=Android Debug" in text and
            "Verified using v2 scheme (APK Signature Scheme v2): true" in text,
            "Expected a verified single-signer development APK")
    return hashes[0]


def inspect_payload(directory: Path, root: Path):
    version, code = source_version(root)
    runtime = expected_map_runtime(root)
    files = {name: fingerprint(directory / name) for name in FILES}
    certificates = set()
    for name in APK_NAMES:
        stem = name.removesuffix(".apk")
        certificates.add(certificate((directory / (stem + ".signature.txt")).read_text()))
        manifest_text = (directory / (stem + ".manifest.txt")).read_text()
        manifest = parse_badging(manifest_text, allow_unversioned=name == TEST_APK)
        if name == TEST_APK:
            require(manifest["applicationId"] == TEST_ID, "Unexpected instrumentation package")
            for line in manifest_text.splitlines():
                if line.startswith("instrumentation:"):
                    fields = dict(re.findall(r"([A-Za-z]+)='([^']*)'", line))
                    require(fields.get("name") == "androidx.test.runner.AndroidJUnitRunner" and
                            fields.get("targetPackage") == APP_ID, "Unexpected instrumentation runner or target")
            continue
        require(manifest == {"applicationId": APP_ID, "version": version, "versionCode": code},
                "APK version/package differs from the checked-out source")
        compression = read_json(directory / (stem + ".compression.json"))
        verification = read_json(directory / (stem + ".verification.json"))
        require(compression.get("outputSha256") == files[name]["sha256"] and
                compression.get("outputBytes") == files[name]["bytes"] and
                all(compression.get(key) is True for key in (
                    "allUncompressedEntrySha256Unchanged", "sameDebugCertificateVerified",
                    "zipAlignment16KVerified", "apkV2SignatureVerified")),
                "Compression/signature receipt is not for this APK")
        require(verification.get("sha256") == files[name]["sha256"] and
                verification.get("sizeBytes") == files[name]["bytes"],
                "Static verification is not for this APK")
        for key, value in runtime.items():
            require(verification.get(key) == value and type(verification.get(key)) is type(value),
                    "APK shared renderer proof differs from the source checkout: " + key)
        expected_abis = {"arm64-v8a"} if name == ARM64 else {"arm64-v8a", "armeabi-v7a", "x86_64"}
        require(set(verification.get("abis", [])) == expected_abis, "Wrong APK architecture")
        require("Verification successful" in (directory / (stem + ".alignment.txt")).read_text(),
                "APK alignment did not pass")
    require(len(certificates) == 1, "App and instrumentation APKs must have the same certificate")
    cert = certificates.pop()
    for name in (UNIVERSAL, ARM64):
        report = read_json(directory / (name.removesuffix(".apk") + ".compression.json"))
        require(report.get("debugCertificateSha256") == cert, "Compression certificate mismatch")
    tests = read_json(directory / "unit-tests.json")
    require(type(tests.get("tests")) is int and tests["tests"] > 0 and
            all(tests.get(key) == 0 for key in ("failures", "errors", "skipped")),
            "Executed JVM tests must pass without skips")
    return {"version": version, "versionCode": code, "applicationId": APP_ID,
            "signingCertificateSha256": cert, "files": files, "jvmTestsPassed": tests["tests"], "mapRuntime": runtime}


def build_receipt(directory: Path, root: Path):
    payload = inspect_payload(directory, root)
    commit = source_checkout(root)
    receipt = {"schemaVersion": 1, "sourceCommit": commit,
               "workflowRunId": os.environ.get("GITHUB_RUN_ID"),
               "workflowRunAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
               "signature": "development / debug", "physicalDeviceVerified": False,
               **payload}
    (directory / RECEIPT).write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def verify_receipt(directory: Path, root: Path):
    receipt = read_json(directory / RECEIPT)
    require(receipt.get("schemaVersion") == 1, "Unknown build receipt schema")
    require(re.fullmatch(r"[a-f0-9]{40}", receipt.get("sourceCommit", "")), "Missing source commit")
    if ci_build():
        require(receipt["sourceCommit"] == source_checkout(root),
                "Artifact does not belong to the unchanged source checkout")
    for key, value in inspect_payload(directory, root).items():
        require(receipt.get(key) == value, f"Build receipt mismatch: {key}")
    for environment, key in (("GITHUB_SHA", "sourceCommit"), ("GITHUB_RUN_ID", "workflowRunId")):
        require(not os.environ.get(environment) or receipt.get(key) == os.environ[environment],
                f"Artifact does not belong to this workflow: {key}")
    return receipt


def verify_sdk(directory: Path, root: Path, sdk: Path):
    receipt = verify_receipt(directory, root)
    for name in APK_NAMES:
        output = subprocess.check_output([str(sdk / "build-tools/36.0.0/apksigner"),
                                          "verify", "--verbose", "--print-certs", str(directory / name)], text=True)
        require(certificate(output) == receipt["signingCertificateSha256"], "Downloaded APK certificate mismatch")
    return receipt


def capture_installed(directory: Path, root: Path, adb: Path, serial: str, output: Path):
    receipt = verify_receipt(directory, root)
    installed = {}
    with tempfile.TemporaryDirectory(prefix="tropnik-installed-") as temporary:
        for package, name in ((APP_ID, UNIVERSAL), (TEST_ID, TEST_APK)):
            result = subprocess.check_output([str(adb), "-s", serial, "shell", "pm", "path", package], text=True)
            paths = [line.removeprefix("package:").strip() for line in result.splitlines() if line.startswith("package:")]
            require(len(paths) == 1 and paths[0].startswith("/data/app/") and paths[0].endswith("/base.apk"),
                    f"Expected one installed base APK for {package}")
            destination = Path(temporary) / name
            subprocess.run([str(adb), "-s", serial, "pull", paths[0], str(destination)], check=True, capture_output=True)
            actual = fingerprint(destination)
            require(actual == receipt["files"][name], f"Installed bytes differ from build artifact: {name}")
            installed[name] = actual
    report = {"schemaVersion": 1, "sourceCommit": receipt["sourceCommit"],
              "workflowRunId": receipt["workflowRunId"], "installedApks": installed,
              "buildReceiptSha256": fingerprint(directory / RECEIPT)["sha256"],
              "installedArtifactBytesVerified": True}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("source", "create", "verify", "installed"))
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--sdk", type=Path)
    parser.add_argument("--serial", default="emulator-5554")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "source":
        print(json.dumps({"sourceCommit": source_checkout(args.root, require_clean=True),
                          "workflowRunId": os.environ.get("GITHUB_RUN_ID")}))
        return
    require(args.directory is not None, "Artifact command requires --directory")
    if args.command == "create":
        result = build_receipt(args.directory, args.root)
    elif args.command == "installed":
        require(args.sdk is not None and args.output is not None, "Installed proof requires SDK and output")
        result = capture_installed(args.directory, args.root, args.sdk / "platform-tools/adb", args.serial, args.output)
    else:
        result = verify_sdk(args.directory, args.root, args.sdk) if args.sdk else verify_receipt(args.directory, args.root)
    print(json.dumps({key: result[key] for key in ("sourceCommit", "workflowRunId")}))


if __name__ == "__main__":
    main()
