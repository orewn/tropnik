#!/usr/bin/env python3
"""Recompress a debug preview, realign, then sign with the same debug certificate.

No resource, geometry or executable byte is transformed. The signing block is
regenerated because ZIP offsets change. Production release signing is outside
this script's scope; a non-debug input certificate is rejected.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from apk_repack import entry_digests, repack_lossless


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--sdk", type=Path, required=True)
    parser.add_argument("--debug-keystore", type=Path, default=Path.home() / ".android/debug.keystore")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    sdk = args.sdk / "build-tools/36.0.0"
    signer, aligner = sdk / "apksigner", sdk / "zipalign"

    def run(command):
        return subprocess.run([str(value) for value in command], check=True, capture_output=True, text=True).stdout

    def certificate(path):
        text = run([signer, "verify", "--verbose", "--print-certs", path])
        matches = re.findall(r"Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})", text)
        if len(matches) != 1 or "CN=Android Debug" not in text:
            raise ValueError("Only a single-signer Android debug preview can be recompressed")
        return matches[0]

    original_certificate = certificate(args.source)
    original_entries = entry_digests(args.source)
    original_size = args.source.stat().st_size
    original_sha = hashlib.sha256(args.source.read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tropnik-apk-compression-", dir=args.output.parent) as directory:
        temporary = Path(directory)
        repacked, aligned, signed = (temporary / name for name in ("repacked.apk", "aligned.apk", "signed.apk"))
        report = repack_lossless(args.source, repacked)
        run([aligner, "-f", "-P", "16", "4", repacked, aligned])
        run([signer, "sign", "--ks", args.debug_keystore, "--ks-key-alias", "androiddebugkey",
             "--ks-pass", "pass:android", "--key-pass", "pass:android",
             "--v1-signing-enabled", "false", "--v2-signing-enabled", "true",
             "--v3-signing-enabled", "false", "--v4-signing-enabled", "false",
             "--out", signed, aligned])
        if certificate(signed) != original_certificate:
            raise ValueError("APK certificate changed during recompression")
        if entry_digests(signed) != original_entries:
            raise ValueError("Signed APK payload differs from the Gradle APK")
        run([aligner, "-c", "-P", "16", "4", signed])
        # Replace the requested artifact only after payload, signature and
        # alignment checks succeed. The original Gradle output remains intact.
        shutil.copy2(signed, args.output)
    report.update({"sourceBytes": original_size, "sourceSha256": original_sha,
                   "outputBytes": args.output.stat().st_size,
                   "outputSha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
                   "savedBytes": original_size - args.output.stat().st_size,
                   "debugCertificateSha256": original_certificate,
                   "sameDebugCertificateVerified": True, "zipAlignment16KVerified": True,
                   "apkV2SignatureVerified": True})
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
