"""Execute the CI installer without network, sudo, or package mutations."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools/android-build/install-ci-libpulse.sh"


class CiLibpulseTest(unittest.TestCase):
    def run_installer(self, *, installed=False, release="ubuntu:24.04:noble", actions="true",
                      keyring="yes", update_exit="0", timeout_exit="0", load_after="yes"):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bins = root / "bin"
            bins.mkdir()
            ready = root / "ready"
            if installed:
                ready.touch()
            mocks = {
                "sudo": '#!/usr/bin/env bash\nexec "$@"\n',
                "timeout": '''#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_TIMEOUT_LOG"
if [[ "$MOCK_TIMEOUT_EXIT" != 0 ]]; then exit "$MOCK_TIMEOUT_EXIT"; fi
exec /usr/bin/timeout "$@"
''',
                "apt-get": f"#!{sys.executable}\n" + '''
import json, os, pathlib, sys
args = sys.argv[1:]
options = dict(args[i + 1].split("=", 1) for i, value in enumerate(args) if value == "-o")
source = pathlib.Path(options["Dir::Etc::SourceList"])
record = {"args": args, "options": options, "sources": source.read_text(),
          "sourceParts": [p.name for p in pathlib.Path(options["Dir::Etc::SourceParts"]).iterdir()]}
with open(os.environ["MOCK_APT_LOG"], "a") as output:
    output.write(json.dumps(record) + "\\n")
if "update" in args:
    sys.exit(int(os.environ["MOCK_UPDATE_EXIT"]))
if os.environ["MOCK_LOAD_AFTER"] == "yes":
    pathlib.Path(os.environ["MOCK_READY"]).touch()
''',
            }
            for name, content in mocks.items():
                path = bins / name
                path.write_text(content)
                path.chmod(0o755)
            env = {**os.environ, "PATH": str(bins) + os.pathsep + os.environ["PATH"],
                   "GITHUB_ACTIONS": actions, "RUNNER_TEMP": str(root),
                   "MOCK_RELEASE": release, "MOCK_KEYRING": keyring, "MOCK_READY": str(ready),
                   "MOCK_APT_LOG": str(root / "apt.jsonl"), "MOCK_TIMEOUT_LOG": str(root / "timeouts"),
                   "MOCK_UPDATE_EXIT": update_exit, "MOCK_TIMEOUT_EXIT": timeout_exit,
                   "MOCK_LOAD_AFTER": load_after}
            # Only environmental probes and privileged external commands are
            # replaced. The real installer creates sources, executes each phase,
            # propagates failures, rechecks the loader, and removes its workspace.
            command = '''
source "$1"
tropnik_runner_release() { printf '%s\\n' "$MOCK_RELEASE"; }
tropnik_libpulse_available() { [[ -f "$MOCK_READY" ]]; }
tropnik_ubuntu_keyring_available() { [[ "$MOCK_KEYRING" == yes ]]; }
tropnik_install_ci_libpulse
'''
            result = subprocess.run(["bash", "-c", command, "test-libpulse", str(SCRIPT)],
                                    env=env, capture_output=True, text=True, timeout=10)
            calls = [json.loads(line) for line in (root / "apt.jsonl").read_text().splitlines()] if (root / "apt.jsonl").exists() else []
            timeouts = (root / "timeouts").read_text().splitlines() if (root / "timeouts").exists() else []
            self.assertEqual(list(root.glob("tropnik-libpulse.*")), [], "temporary apt state leaked")
            return result, calls, timeouts

    def test_loadable_library_needs_no_apt_or_network(self):
        result, calls, timeouts = self.run_installer(installed=True, keyring="no")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((calls, timeouts), ([], []))
        self.assertIn("already loadable", result.stdout)

    def test_missing_library_uses_only_signed_official_noble_sources(self):
        result, calls, timeouts = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["args"][-2:], ["update", "--error-on=any"])
        self.assertEqual(calls[1]["args"][-4:], ["install", "--yes", "--no-install-recommends", "libpulse0"])
        self.assertEqual(calls[0]["options"], calls[1]["options"])
        for call in calls:
            options = call["options"]
            self.assertEqual(call["sourceParts"], [])
            directory = Path(options["Dir::Etc::SourceList"]).parent
            for key in ["Dir::Etc::SourceParts", "Dir::State::Lists", "Dir::Cache::Archives"]:
                self.assertEqual(Path(options[key]).parent, directory)
            self.assertTrue(directory.name.startswith("tropnik-libpulse."))
            for key, value in {"Acquire::Retries": "1", "Acquire::http::Timeout": "15",
                               "Acquire::https::Timeout": "15", "Acquire::AllowInsecureRepositories": "false",
                               "APT::Get::AllowUnauthenticated": "false"}.items():
                self.assertEqual(options[key], value)
            stanzas = [dict(line.split(": ", 1) for line in block.splitlines())
                       for block in call["sources"].strip().split("\n\n")]
            self.assertEqual([(s["URIs"], s["Suites"]) for s in stanzas], [
                ("https://archive.ubuntu.com/ubuntu", "noble noble-updates"),
                ("https://security.ubuntu.com/ubuntu", "noble-security")])
            for stanza in stanzas:
                self.assertEqual(stanza["Signed-By"], "/usr/share/keyrings/ubuntu-archive-keyring.gpg")
                self.assertEqual(stanza["Types"], "deb")
                self.assertEqual(stanza["Components"], "main")
                self.assertNotIn("Trusted", stanza)
        self.assertEqual(len(timeouts), 2)
        self.assertTrue(all(line.startswith("--signal=TERM --kill-after=5s 90s apt-get ") for line in timeouts))
        self.assertIn("Verified", result.stdout)

    def test_failed_update_cannot_install_using_cached_indexes(self):
        result, calls, timeouts = self.run_installer(update_exit="100")
        self.assertEqual(result.returncode, 100)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(timeouts), 1)
        self.assertNotIn("Verified", result.stdout)

    def test_timeout_stops_before_install_and_is_not_reported_as_success(self):
        result, calls, timeouts = self.run_installer(timeout_exit="124")
        self.assertEqual(result.returncode, 124)
        self.assertEqual(calls, [])
        self.assertEqual(len(timeouts), 1)
        self.assertNotIn("Verified", result.stdout)

    def test_successful_apt_still_requires_a_loadable_soname(self):
        result, calls, _ = self.run_installer(load_after="no")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 2)
        self.assertNotIn("Verified", result.stdout)

    def test_missing_packaged_keyring_is_a_failure_before_network(self):
        result, calls, timeouts = self.run_installer(keyring="no")
        self.assertEqual(result.returncode, 1)
        self.assertEqual((calls, timeouts), ([], []))
        self.assertIn("keyring is missing", result.stderr)

    def test_other_hosts_are_rejected_even_with_an_installed_library(self):
        for options in [{"release": "ubuntu:22.04:jammy"}, {"release": "debian:13:trixie"},
                        {"release": "ubuntu:24.04:other"}, {"actions": "false"}]:
            with self.subTest(options=options):
                result, calls, timeouts = self.run_installer(installed=True, **options)
                self.assertEqual(result.returncode, 2)
                self.assertEqual((calls, timeouts), ([], []))

    def test_live_and_template_workflows_use_the_bounded_installer(self):
        for relative in [".github/workflows/android.yml", "tools/android-build/github-actions.yml"]:
            text = (ROOT / relative).read_text()
            section = text.split("- name: Install emulator shared-library dependency", 1)[1].split("- name:", 1)[0]
            self.assertIn("timeout-minutes: 5", section)
            self.assertIn("run: bash tools/android-build/install-ci-libpulse.sh", section)
            self.assertNotIn("apt-get update", section)


if __name__ == "__main__":
    unittest.main()
