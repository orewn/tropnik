#!/usr/bin/env python3
"""Run an isolated Android preview emulator and accept local QA commands.

This is development tooling, not part of the APK. A real connected phone is
never selected: all adb calls are pinned to emulator-5554. The queue enables
screenshot inspection when the executor gives each command a network namespace.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import zipfile


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sdk", required=True, type=Path)
    parser.add_argument("--avd-home", required=True, type=Path)
    parser.add_argument("--avd", default="tropnik-test")
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--max-seconds", type=int, default=1800)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    queue = args.out / "queue"
    queue.mkdir(exist_ok=True)
    env = {**os.environ, "ANDROID_SDK_ROOT": str(args.sdk), "ANDROID_AVD_HOME": str(args.avd_home)}
    adb_path = str(args.sdk / "platform-tools/adb")
    serial = "emulator-5554"

    def adb(*arguments: str, timeout: int = 45) -> subprocess.CompletedProcess:
        return subprocess.run([adb_path, "-s", serial, *arguments], env=env, capture_output=True, timeout=timeout)

    def status(phase: str, **values) -> None:
        (args.out / "state.json").write_text(json.dumps({"phase": phase, **values}, ensure_ascii=False, indent=2))
        print(phase, values, flush=True)

    log = (args.out / "emulator.log").open("w")
    emulator = subprocess.Popen([
        str(args.sdk / "emulator/emulator"), "-avd", args.avd, "-port", "5554",
        "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-accel", "off",
        "-gpu", "swiftshader_indirect", "-memory", "2048", "-cores", "4", "-feature", "-Vulkan",
    ], env=env, stdout=log, stderr=subprocess.STDOUT)
    start = time.monotonic()
    try:
        subprocess.run([adb_path, "start-server"], env=env, capture_output=True, timeout=15)
        status("booting")
        booted = False
        boot_poll_timeouts = 0
        while time.monotonic() - start < 480:
            if emulator.poll() is not None:
                raise RuntimeError(f"Emulator exited with {emulator.returncode}; inspect emulator.log")
            try:
                response = adb("shell", "getprop", "sys.boot_completed", timeout=12)
            except subprocess.TimeoutExpired:
                # Software CPU emulation can stall one adb poll while Android
                # starts. A bounded poll timeout is not an emulator crash; keep
                # the original overall eight-minute boot deadline.
                boot_poll_timeouts += 1
                status("booting", adbPollTimeouts=boot_poll_timeouts,
                       elapsedSeconds=round(time.monotonic() - start))
                continue
            if response.returncode == 0 and response.stdout.strip() == b"1":
                booted = True
                break
            time.sleep(5)
        if not booted:
            raise RuntimeError("Software emulator did not finish booting within 8 minutes")
        status("booted")
        adb("shell", "settings", "put", "global", "window_animation_scale", "0")
        adb("shell", "settings", "put", "global", "transition_animation_scale", "0")
        adb("shell", "settings", "put", "global", "animator_duration_scale", "0")
        adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        adb("shell", "input", "keyevent", "82")
        status("waiting_for_apk")
        while time.monotonic() - start < args.max_seconds:
            if args.apk.exists() and zipfile.is_zipfile(args.apk):
                break
            time.sleep(3)
        if not args.apk.exists():
            raise RuntimeError("APK did not become available")
        result = adb("install", "-r", str(args.apk), timeout=180)
        (args.out / "install.txt").write_bytes(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError("adb install failed; inspect install.txt")
        result = adb("shell", "am", "start", "-W", "-n", "ru.tropa.app.preview/ru.tropa.app.MainActivity", timeout=90)
        (args.out / "launch.txt").write_bytes(result.stdout + result.stderr)
        time.sleep(5)
        (args.out / "home.png").write_bytes(adb("exec-out", "screencap", "-p", timeout=30).stdout)
        adb("shell", "uiautomator", "dump", "/sdcard/tropnik-ui.xml", timeout=45)
        adb("pull", "/sdcard/tropnik-ui.xml", str(args.out / "home.xml"), timeout=30)
        status("ready", serial=serial, apk=str(args.apk))
        while time.monotonic() - start < args.max_seconds:
            if emulator.poll() is not None:
                raise RuntimeError("Emulator exited while running QA")
            for request_file in sorted(queue.glob("*.json")):
                command = json.loads(request_file.read_text())
                request_file.rename(request_file.with_suffix(".running"))
                if command.get("stop"):
                    status("stopped")
                    return
                values = command.get("args", [])
                if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
                    raise ValueError("adb args must be a list of strings")
                result = adb(*values, timeout=min(int(command.get("timeout", 60)), 240))
                name = Path(command.get("output", request_file.stem + ".txt")).name
                target = args.out / name
                target.write_bytes(result.stdout if command.get("binary") else result.stdout + result.stderr)
                request_file.with_suffix(".result").write_text(json.dumps({"exitCode": result.returncode, "output": str(target)}))
                request_file.with_suffix(".running").unlink()
            time.sleep(.5)
    except Exception as error:
        status("failed", reason=str(error), elapsedSeconds=round(time.monotonic() - start))
        raise
    finally:
        try:
            adb("emu", "kill", timeout=10)
        except Exception:
            emulator.terminate()
        try:
            emulator.wait(timeout=15)
        except subprocess.TimeoutExpired:
            emulator.kill()
        log.close()


if __name__ == "__main__":
    main()
