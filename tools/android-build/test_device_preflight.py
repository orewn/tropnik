"""The CI recovery cannot hide application ANRs or stop arbitrary packages."""
import importlib.util
import json
from pathlib import Path
from subprocess import CompletedProcess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("device_preflight", Path(__file__).with_name("device-preflight.py"))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)

READY = "Window #0 Window{a1 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity}"
# Exact window title retained in run 42662715649 / job 129320833344.
LAUNCHER_ANR = "Window #0 Window{cac2a8f u0 Application Not Responding: com.google.android.apps.nexuslauncher}"


class DevicePreflightTest(unittest.TestCase):
    def run_preflight(self, windows, timeout=20):
        calls = []
        snapshots = iter(windows)
        last = windows[-1]

        def run(command, **kwargs):
            calls.append(command[3:])
            output = next(snapshots, last) if command[3:] == ["shell", "dumpsys", "window", "windows"] else "diagnostics"
            return CompletedProcess(command, 0, stdout=output)

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(preflight.subprocess, "run", side_effect=run), patch.object(preflight.time, "sleep"), patch.object(preflight.time, "monotonic", side_effect=range(100)):
                try:
                    preflight.prepare("adb", "emulator-5554", Path(directory), timeout_seconds=timeout)
                except RuntimeError:
                    self.calls = calls
                    raise
            report = json.loads((Path(directory) / "device-preflight.json").read_text())
            preserved = (Path(directory) / "preflight-launcher-anr.txt").exists()
        return calls, report, preserved

    def test_ready_device_never_stops_a_process(self):
        calls, report, preserved = self.run_preflight([READY, READY])
        self.assertFalse(report["pixelLauncherAnrRecovered"])
        self.assertFalse(preserved)
        self.assertFalse(any("force-stop" in call for call in calls))

    def test_exact_observed_launcher_anr_is_recorded_and_recovered_once(self):
        calls, report, preserved = self.run_preflight([LAUNCHER_ANR, READY, READY])
        self.assertTrue(report["ready"])
        self.assertTrue(report["pixelLauncherAnrRecovered"])
        self.assertTrue(preserved)
        self.assertEqual([call for call in calls if "force-stop" in call], [["shell", "am", "force-stop", preflight.PIXEL_LAUNCHER]])

    def test_tropnik_other_and_mixed_anrs_are_failures_without_recovery(self):
        for package in ["ru.tropa.app.preview", "ru.tropa.app.preview.test", "com.google.android.apps.nexuslauncher.other", "com.android.systemui"]:
            for prefix in ["", LAUNCHER_ANR + "\n"]:
                with self.subTest(package=package, prefix=bool(prefix)), self.assertRaisesRegex(RuntimeError, "ANR blocks"):
                    self.run_preflight([prefix + f"Window{{a2 u0 Application Not Responding: {package}}}"])
                self.assertFalse(any("force-stop" in call for call in self.calls))

    def test_unknown_anr_and_empty_diagnostics_fail_closed(self):
        for text in ["Application Not Responding", ""]:
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                self.run_preflight([text])
            self.assertFalse(any("force-stop" in call for call in self.calls))

    def test_persistent_launcher_dialog_times_out_without_repeated_stops(self):
        with self.assertRaisesRegex(RuntimeError, "bounded preflight"):
            self.run_preflight([LAUNCHER_ANR], timeout=3)
        self.assertEqual(sum("force-stop" in call for call in self.calls), 1)


if __name__ == "__main__":
    unittest.main()
