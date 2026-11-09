#!/usr/bin/env python3
"""Remove only the observed boot-time Pixel Launcher ANR on the owned CI AVD."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time

PIXEL_LAUNCHER = "com.google.android.apps.nexuslauncher"
ANR_TITLE = re.compile(r"Application Not Responding: ([A-Za-z0-9_.:]+)(?=[}\s])")


def anr_packages(windows: str) -> set[str]:
    packages = set(ANR_TITLE.findall(windows))
    if "Application Not Responding" in windows and not packages:
        raise RuntimeError("Unrecognized system ANR window; no process will be stopped")
    if packages - {PIXEL_LAUNCHER}:
        raise RuntimeError(f"An unrelated/app ANR blocks device verification: {sorted(packages)}")
    return packages


def prepare(adb: str, serial: str, output: Path, timeout_seconds: float = 20) -> None:
    if serial != "emulator-5554":
        raise RuntimeError("Preflight is restricted to the disposable CI emulator-5554")
    output.mkdir(parents=True, exist_ok=True)

    def command(*args: str) -> str:
        return subprocess.run([adb, "-s", serial, *args], check=True, capture_output=True,
                              text=True, timeout=5).stdout

    deadline = time.monotonic() + timeout_seconds
    recovered = False
    clear_samples = 0
    sample = 0
    while True:
        windows = command("shell", "dumpsys", "window", "windows")
        if not windows.strip():
            raise RuntimeError("Window diagnostics are empty; device readiness is unverified")
        if sample == 0:
            (output / "preflight-window-before.txt").write_text(windows)
        sample += 1
        (output / "preflight-window-after.txt").write_text(windows)
        packages = anr_packages(windows)
        if packages:
            clear_samples = 0
            if not recovered:
                # Persist the evidence before this single allowed recovery. Do
                # not clear logcat or globally disable application ANR dialogs.
                (output / "preflight-launcher-anr.txt").write_text(windows)
                (output / "preflight-logcat.txt").write_text(command("logcat", "-d", "-v", "threadtime"))
                command("shell", "am", "force-stop", PIXEL_LAUNCHER)
                recovered = True
        else:
            clear_samples += 1
            if clear_samples >= 2:
                result = {"ready": True, "pixelLauncherAnrRecovered": recovered,
                          "forceStoppedPackage": PIXEL_LAUNCHER if recovered else None,
                          "serial": serial, "samples": sample}
                (output / "device-preflight.json").write_text(json.dumps(result, indent=2) + "\n")
                print(json.dumps(result))
                return
        if time.monotonic() >= deadline:
            raise RuntimeError("The emulator ANR window did not clear within the bounded preflight")
        time.sleep(.5)


def main() -> None:
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("This preflight only runs on the GitHub Actions disposable emulator")
    parser = argparse.ArgumentParser()
    parser.add_argument("--adb", required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    prepare(args.adb, args.serial, args.output)


if __name__ == "__main__":
    main()
