#!/usr/bin/env python3
"""Verify production identity/signing without generating keys or publishing.

The explicit unsigned check proves build/payload integrity only. It is never a
signed or device-tested release, and cannot pass the signed verification mode.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import zipfile
from urllib.parse import urlsplit

from preview_artifacts import expected_map_runtime, fingerprint, parse_badging, require, source_checkout, source_version

SIGNING_NAMES = ("TROPNIK_RELEASE_KEYSTORE", "TROPNIK_RELEASE_STORE_PASSWORD",
                 "TROPNIK_RELEASE_KEY_ALIAS", "TROPNIK_RELEASE_KEY_PASSWORD",
                 "TROPNIK_RELEASE_CERT_SHA256")


def signing_inputs(environment, root: Path):
    require(all(environment.get(name) for name in SIGNING_NAMES),
            "Provide the external release keystore, passwords, alias and expected certificate SHA-256")
    path = Path(environment["TROPNIK_RELEASE_KEYSTORE"])
    require(path.is_absolute() and path.is_file() and not path.is_symlink(),
            "The production keystore must be an absolute regular file outside the repository")
    require(not path.resolve().is_relative_to(root.resolve()), "Do not store a production keystore in the repository")
    require(stat.S_IMODE(path.stat().st_mode) & 0o077 == 0, "Production keystore permissions must exclude group and other users")
    alias = environment["TROPNIK_RELEASE_KEY_ALIAS"]
    require(bool(alias.strip()) and alias.lower() != "androiddebugkey" and "\n" not in alias,
            "A production key alias is required; the Android debug key is forbidden")
    digest = environment["TROPNIK_RELEASE_CERT_SHA256"].lower().replace(":", "")
    require(re.fullmatch(r"[a-f0-9]{64}", digest) is not None, "Expected certificate SHA-256 is invalid")
    origin = urlsplit(environment.get("TROPA_API_BASE_URL", ""))
    require(origin.scheme == "https" and bool(origin.hostname) and not origin.username and not origin.password
            and not origin.query and not origin.fragment,
            "A configured HTTPS API origin is required for a production candidate")
    return path, alias, digest


def preflight(root: Path, unsigned: bool):
    if unsigned:
        require(not any(os.environ.get(name) for name in SIGNING_NAMES),
                "Unsigned CI check must not receive production signing credentials")
        return None
    path, alias, digest = signing_inputs(os.environ, root)
    # Passwords are environment references, never command-line values. Do not
    # relay tool stderr, which may contain machine paths or provider diagnostics.
    exported = subprocess.run(["keytool", "-exportcert", "-keystore", str(path),
        "-storepass:env", "TROPNIK_RELEASE_STORE_PASSWORD", "-alias", alias],
        capture_output=True, check=False)
    require(exported.returncode == 0 and exported.stdout, "Could not verify the external signing certificate")
    require(hashlib.sha256(exported.stdout).hexdigest() == digest,
            "External signing certificate differs from the independently recorded fingerprint")
    return digest


def production_badging(text: str, version: str, code: int):
    manifest = parse_badging(text)
    require(manifest == {"applicationId": "ru.tropa.app", "versionCode": code, "version": version},
            "Production identity/version differs from the reviewed source")
    require(not re.search(r"^application-debuggable(?:\s|$)", text, re.M), "Production APK is debuggable")
    # Current build-tools 36 emits minSdkVersion; older aapt2 used sdkVersion.
    # Accept either spelling, with exactly one unambiguous minimum and target.
    minimum = re.findall(r"^(?:minSdkVersion|sdkVersion):(.*)$", text, re.M)
    target = re.findall(r"^targetSdkVersion:(.*)$", text, re.M)
    require(minimum == ["'26'"] and target == ["'36'"],
            f"Production SDK levels differ from the supported policy: minimum={minimum!r}, target={target!r}")
    return manifest


def production_certificate(text: str, expected: str):
    hashes = re.findall(r"^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})$", text, re.M)
    require(hashes == [expected] and "Android Debug" not in text
            and "Verified using v2 scheme (APK Signature Scheme v2): true" in text,
            "Expected the pinned, non-debug, single-signer production certificate")
    return hashes[0]


def unsigned_signature(apk: Path, result):
    # A crashed/missing SDK verifier is not evidence that an APK is unsigned.
    diagnostics = (result.stdout + "\n" + result.stderr).splitlines()
    require(result.returncode == 1 and "DOES NOT VERIFY" in diagnostics
            and "ERROR: Missing META-INF/MANIFEST.MF" in diagnostics
            and all(not line.startswith("ERROR:") or line == "ERROR: Missing META-INF/MANIFEST.MF" for line in diagnostics)
            and not any("Exception" in line or "certificate SHA-256 digest:" in line for line in diagnostics),
            "SDK verifier did not report the expected unsigned APK result")
    with zipfile.ZipFile(apk) as archive:
        require(not any(re.fullmatch(r"META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))", name.upper())
                        for name in archive.namelist()), "Unsigned check contains JAR signing material")
    data = apk.read_bytes()
    end = data.rfind(b"PK\x05\x06", max(0, len(data) - 65557))
    require(end >= 0 and end + 22 <= len(data), "APK central-directory trailer is missing")
    comment_bytes = struct.unpack_from("<H", data, end + 20)[0]
    require(end + 22 + comment_bytes == len(data), "APK central-directory trailer is invalid")
    central = struct.unpack_from("<I", data, end + 16)[0]
    require(central < end and data[central:central + 4] == b"PK\x01\x02", "APK central-directory offset is invalid")
    require(data[max(0, central - 16):central] != b"APK Sig Block 42", "Unsigned check contains an APK signing block")


def compiler_profile_diagnostics(apk: Path, root: Path):
    """Bounded public metadata for the actual APK and Gradle task outputs.

    This report never substitutes for byte-for-byte verification and contains
    neither file contents nor signing inputs. Preserve it when a gate fails.
    """
    root = root.resolve()
    maximum_file_bytes, maximum_total_bytes = 8_000_000, 32_000_000
    total_bytes = 0
    apk_profiles = []
    with zipfile.ZipFile(apk) as archive:
        entries = [entry for entry in archive.infolist()
                   if entry.filename.startswith("assets/dexopt/") and not entry.is_dir()]
        require(len(entries) <= 32, "Too many APK profile diagnostic entries")
        for entry in sorted(entries, key=lambda item: item.filename):
            total_bytes += entry.file_size
            require(0 <= entry.file_size <= maximum_file_bytes and total_bytes <= maximum_total_bytes,
                    "APK profile diagnostic budget exceeded")
            data = archive.read(entry)
            apk_profiles.append({"path": entry.filename, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                                 "magicHex": data[:8].hex()})
    intermediates = root / "android/app/build/intermediates"
    paths = sorted(path for directory in intermediates.glob("*/release/compileReleaseArtProfile")
                   for path in directory.rglob("*") if path.is_file())
    require(len(paths) <= 32, "Too many compiler profile diagnostic entries")
    outputs = []
    for path in paths:
        require(path.resolve().is_relative_to(intermediates) and not path.is_symlink()
                and not any(parent.is_symlink() for parent in path.parents if parent.is_relative_to(intermediates)),
                "Linked compiler profile diagnostic output")
        total_bytes += path.stat().st_size
        require(path.stat().st_size <= maximum_file_bytes and total_bytes <= maximum_total_bytes,
                "Compiler profile diagnostic budget exceeded")
        with path.open("rb") as source:
            magic = source.read(8).hex()
        outputs.append({"path": path.relative_to(root).as_posix(), **fingerprint(path), "magicHex": magic})
    return {"schemaVersion": 1, "diagnosticOnly": True, "apk": fingerprint(apk),
            "apkDexoptAssets": apk_profiles, "compileReleaseArtProfileOutputs": outputs}


def verify(apk: Path, sdk: Path, root: Path, unsigned: bool, expected_source: str):
    commit = source_checkout(root, require_clean=True)
    require(re.fullmatch(r"[a-f0-9]{40}", expected_source or "") is not None and commit == expected_source,
            "Checkout differs from the source held before the Gradle build")
    expected = preflight(root, unsigned)
    initial = fingerprint(apk)
    version, code = source_version(root)
    version = version.removesuffix("-preview")
    binaries = sdk / "build-tools/36.0.0"
    badging = subprocess.check_output([str(binaries / "aapt2"), "dump", "badging", str(apk)], text=True)
    manifest = production_badging(badging, version, code)
    alignment = subprocess.run([str(binaries / "zipalign"), "-c", "-P", "16", "4", str(apk)],
                               capture_output=True, check=False)
    require(alignment.returncode == 0, "Production APK ZIP alignment failed")
    signature = subprocess.run([str(binaries / "apksigner"), "verify", "--verbose", "--print-certs", str(apk)],
                               capture_output=True, text=True, check=False)
    if unsigned:
        unsigned_signature(apk, signature)
        certificate = None
    else:
        require(signature.returncode == 0, "Production APK signature verification failed")
        certificate = production_certificate(signature.stdout, expected)
    spec = importlib.util.spec_from_file_location("production_apk_payload", Path(__file__).with_name("verify-apk.py"))
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    payload = verifier.verify_apk(apk, source_root=root)
    require(payload["sha256"] == initial["sha256"] and payload["sizeBytes"] == initial["bytes"]
            and fingerprint(apk) == initial, "Candidate APK changed while it was being verified")
    runtime = expected_map_runtime(root)
    require(all(payload.get(key) == value for key, value in runtime.items()),
            "Production map runtime differs from the held source checkout")
    require(payload["abis"] == ["arm64-v8a", "armeabi-v7a", "x86_64"], "Production candidate must be universal")
    require(source_checkout(root, require_clean=True) == commit, "Source changed during production verification")
    require(fingerprint(apk) == initial, "Candidate APK changed before the verification receipt")
    return {"schemaVersion": 1, "kind": "unsigned-production-build-check" if unsigned else "signed-production-candidate",
            "sourceCommit": commit, "workflowRunId": os.environ.get("GITHUB_RUN_ID"),
            **manifest, **initial, "debuggable": False, "payload": payload,
            "signatureVerified": not unsigned, "signingCertificateSha256": certificate,
            "productionPublished": False, "deviceExecutionVerified": False,
            "liveApiVerified": False, "upgradeVerified": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("preflight", "verify"))
    parser.add_argument("--unsigned-check", action="store_true")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--apk", type=Path)
    parser.add_argument("--sdk", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--expected-source")
    args = parser.parse_args()
    if args.operation == "preflight":
        preflight(args.root, args.unsigned_check)
        print("Unsigned build preflight passed" if args.unsigned_check else "External signing certificate preflight passed")
        return
    require(args.apk is not None and args.sdk is not None and args.output is not None and args.expected_source is not None,
            "Verification requires --apk, --sdk, --output and --expected-source")
    diagnostics = compiler_profile_diagnostics(args.apk, args.root)
    diagnostics["expectedSourceCommit"] = args.expected_source
    args.output.with_name("production-diagnostics.json").write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2) + "\n")
    result = verify(args.apk, args.sdk, args.root, args.unsigned_check, args.expected_source)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ("kind", "sourceCommit", "applicationId", "version", "sha256", "signatureVerified")}))


if __name__ == "__main__":
    main()
