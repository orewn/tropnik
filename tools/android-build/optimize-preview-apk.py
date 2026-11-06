#!/usr/bin/env python3
"""Recompress a debug preview, realign, then sign with its Gradle debug certificate.

No resource, geometry or executable byte is transformed. The signing block is
regenerated because ZIP offsets change. Production release signing is outside
this script's scope; a non-debug input certificate is rejected. The current
Gradle signing report supplies the store path rather than guessing a user home.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from apk_repack import entry_digests, repack_lossless


def run_checked(command):
    """Retain actionable SDK stderr without echoing password arguments."""
    command = [str(value) for value in command]
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode:
        detail = result.stderr or result.stdout or "The SDK tool did not provide diagnostics."
        secrets = set()
        for index, value in enumerate(command[:-1]):
            if value in {"--ks-pass", "--key-pass"}:
                secret = command[index + 1]
                secrets.add(secret)
                if secret.startswith("pass:") and secret[5:]:
                    secrets.add(secret[5:])
        # Longest first also redacts overlapping store/key passwords completely.
        for secret in sorted(secrets, key=len, reverse=True):
            detail = detail.replace(secret, "[REDACTED]")
        detail = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", detail)
        raise RuntimeError(f"{Path(command[0]).name} failed with exit {result.returncode}:\n{detail[-4000:].strip()}")
    return result.stdout


def debug_signing_from_report(text, expected_certificate):
    """Read only the debug variant from the official Gradle signingReport task.

    Android documents the report's Store field as the authoritative location:
    https://developer.android.com/studio/publish/app-signing#debug-mode
    No keystore bytes or passwords are read or returned by this parser.
    """
    if len(text.encode("utf-8")) > 1024 * 1024:
        raise ValueError("Gradle signing report exceeds its bounded size")
    blocks = []
    current = None
    for line in text.splitlines():
        match = re.fullmatch(r"\s*(Variant|Config|Store|Alias|SHA-256):\s*(.*?)\s*", line)
        if not match:
            continue
        key, value = match.groups()
        if key == "Variant":
            current = {key: value}
            blocks.append(current)
        elif current is not None:
            if key in current:
                raise ValueError("Duplicate field in Gradle signing report")
            current[key] = value
    matches = [block for block in blocks if block.get("Variant") == "debug"]
    if len(matches) != 1 or matches[0].get("Config") != "debug":
        raise ValueError("Exactly one debug signing configuration is required")
    block = matches[0]
    digest = block.get("SHA-256", "").replace(":", "").lower()
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or digest != expected_certificate:
        raise ValueError("Gradle debug signing certificate differs from the source APK")
    store = Path(block.get("Store", ""))
    alias = block.get("Alias", "")
    if not store.is_absolute() or store.name != "debug.keystore" or not store.is_file():
        raise ValueError("Gradle debug signing report does not identify an existing absolute debug.keystore")
    if alias.lower() != "androiddebugkey":
        raise ValueError("Only the standard Android debug key alias is supported")
    return store, alias


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--sdk", type=Path, required=True)
    signing = parser.add_mutually_exclusive_group(required=True)
    signing.add_argument("--signing-report", type=Path)
    signing.add_argument("--debug-keystore", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    sdk = args.sdk / "build-tools/36.0.0"
    signer, aligner = sdk / "apksigner", sdk / "zipalign"

    def certificate(path):
        text = run_checked([signer, "verify", "--verbose", "--print-certs", path])
        matches = re.findall(r"Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})", text)
        if len(matches) != 1 or "CN=Android Debug" not in text:
            raise ValueError("Only a single-signer Android debug preview can be recompressed")
        return matches[0]

    original_certificate = certificate(args.source)
    if args.signing_report:
        if args.signing_report.stat().st_size > 1024 * 1024:
            raise ValueError("Gradle signing report exceeds its bounded size")
        debug_keystore, debug_alias = debug_signing_from_report(args.signing_report.read_text(), original_certificate)
    else:
        debug_keystore, debug_alias = args.debug_keystore, "androiddebugkey"
        if not debug_keystore.is_file():
            raise ValueError("The explicitly selected debug keystore does not exist")
    original_entries = entry_digests(args.source)
    original_size = args.source.stat().st_size
    original_sha = hashlib.sha256(args.source.read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tropnik-apk-compression-", dir=args.output.parent) as directory:
        temporary = Path(directory)
        repacked, aligned, signed = (temporary / name for name in ("repacked.apk", "aligned.apk", "signed.apk"))
        report = repack_lossless(args.source, repacked)
        run_checked([aligner, "-f", "-P", "16", "4", repacked, aligned])
        run_checked([signer, "sign", "--ks", debug_keystore, "--ks-key-alias", debug_alias,
                     "--ks-pass", "pass:android", "--key-pass", "pass:android",
                     "--v1-signing-enabled", "false", "--v2-signing-enabled", "true",
                     "--v3-signing-enabled", "false", "--v4-signing-enabled", "false",
                     "--out", signed, aligned])
        if certificate(signed) != original_certificate:
            raise ValueError("APK certificate changed during recompression")
        if entry_digests(signed) != original_entries:
            raise ValueError("Signed APK payload differs from the Gradle APK")
        run_checked([aligner, "-c", "-P", "16", "4", signed])
        # Publish only after payload, signature and alignment checks succeed.
        # The original Gradle output and the current debug key remain intact.
        shutil.copy2(signed, args.output)
    report.update({"sourceBytes": original_size, "sourceSha256": original_sha,
                   "outputBytes": args.output.stat().st_size,
                   "outputSha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
                   "savedBytes": original_size - args.output.stat().st_size,
                   "debugCertificateSha256": original_certificate,
                   "debugSigningConfigSource": "gradle-signing-report" if args.signing_report else "explicit-path",
                   "sameDebugCertificateVerified": True, "zipAlignment16KVerified": True,
                   "apkV2SignatureVerified": True})
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
