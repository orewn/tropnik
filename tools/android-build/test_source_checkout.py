"""Exercise CI source provenance with real Git and the build entry point."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import preview_artifacts as artifacts

HERE = Path(__file__).resolve().parent
CI_KEYS = ("GITHUB_ACTIONS", "GITHUB_SHA", "GITHUB_RUN_ID")


class SourceCheckoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.input = self.root / "android/app/src/main/assets/catalog.json"
        self.input.parent.mkdir(parents=True)
        self.input.write_text("committed input\n")
        (self.root / ".gitignore").write_text("build/\n.gradle/\nnode_modules/\n__pycache__/\n")
        self.git("init", "--initial-branch=main")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Source")
        self.commit = self.git("rev-parse", "HEAD")
        self.env = {"GITHUB_ACTIONS": "true", "GITHUB_SHA": self.commit, "GITHUB_RUN_ID": "123"}

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.DEVNULL, text=True).strip()

    def test_clean_commit_allows_build_caches_and_separate_device_reports(self):
        for name in ("android/app/build/generated/ignored.kt", "android/.gradle/state",
                     "web/node_modules/typescript/cache", "android/dist/preview-build.json",
                     "android/device-proof/device-result.json", "android/release/checksums.sha256"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("generated output\n")
        with patch.dict(os.environ, self.env):
            self.assertEqual(artifacts.source_checkout(self.root), self.commit)

    def test_worktree_staged_and_deleted_inputs_cannot_claim_the_commit(self):
        with patch.dict(os.environ, self.env):
            self.input.write_text("uncommitted generated input\n")
            with self.assertRaisesRegex(ValueError, "inputs differ"):
                artifacts.source_checkout(self.root)
            self.git("add", ".")
            with self.assertRaisesRegex(ValueError, "inputs differ"):
                artifacts.source_checkout(self.root)
            self.git("restore", "--staged", "--worktree", ".")
            self.input.unlink()
            with self.assertRaisesRegex(ValueError, "inputs differ"):
                artifacts.source_checkout(self.root)

    def test_untracked_native_code_and_shared_assets_are_not_part_of_git_archive(self):
        with patch.dict(os.environ, self.env):
            for name in ("android/app/src/main/java/Injected.kt", "web/public/data/routes/new.geojson",
                         "tools/android-build/untracked-generator.py"):
                with self.subTest(path=name):
                    path = self.root / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("not in source commit\n")
                    with self.assertRaisesRegex(ValueError, "inputs differ"):
                        artifacts.source_checkout(self.root)
                    path.unlink()

    def test_missing_malformed_and_foreign_workflow_commits_fail(self):
        for value in ("", "main", "0" * 40):
            with self.subTest(sha=value), patch.dict(os.environ, {**self.env, "GITHUB_SHA": value}):
                with self.assertRaises(ValueError):
                    artifacts.source_checkout(self.root)

    def test_local_development_can_regenerate_without_claiming_a_ci_run(self):
        self.input.write_text("local development input\n")
        with patch.dict(os.environ, {key: "" for key in CI_KEYS}):
            self.assertFalse(artifacts.ci_build())
            self.assertEqual(artifacts.source_checkout(self.root), self.commit)
            with self.assertRaisesRegex(ValueError, "inputs differ"):
                artifacts.source_checkout(self.root, require_clean=True)


class BuildEntryPointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "source"
        scripts = self.root / "tools/android-build"
        scripts.mkdir(parents=True)
        for name in ("build.sh", "preview_artifacts.py"):
            shutil.copyfile(HERE / name, scripts / name)
        self.assets = self.root / "android/app/src/main/assets"
        self.assets.mkdir(parents=True)
        (scripts / "prepare-catalog.mjs").write_text("""
import {readFileSync,writeFileSync} from 'node:fs';
const path=new URL('../../android/app/src/main/assets/catalog.json',import.meta.url);
if(process.argv.includes('--check')) {
  if(readFileSync(path,'utf8')!=='fresh\\n') throw Error('fixture stale catalogue');
} else writeFileSync(path,'fresh\\n');
""")
        (scripts / "prepare-landscape.py").write_text("""
from pathlib import Path
import sys
path=Path(__file__).resolve().parents[2]/'android/app/src/main/assets/landscape.html'
if '--check' in sys.argv:
    if path.read_text()!='fresh\\n': raise SystemExit('fixture stale terrain')
else: path.write_text('fresh\\n')
""")
        (scripts / "prepare-custom-map.mjs").write_text("""
import {readFileSync,writeFileSync} from 'node:fs';
const path=new URL('../../android/app/src/main/assets/custom-map.js',import.meta.url);
if(process.argv.includes('--check')) {
  if(readFileSync(path,'utf8')!=='fresh\\n') throw Error('fixture stale shared map');
} else writeFileSync(path,'fresh\\n');
""")
        (scripts / "test-landscape-bootstrap.mjs").write_text(
            "console.error('fixture stopped before Gradle');process.exit(83);\n")
        (scripts / "test_fixture.py").write_text("""
from pathlib import Path
import unittest
class PreparedInputs(unittest.TestCase):
    def test_derivatives_reached_the_test_stage(self):
        assets=Path(__file__).resolve().parents[2]/'android/app/src/main/assets'
        for name in ('catalog.json','landscape.html','custom-map.js'):
            self.assertEqual((assets/name).read_text(),'fresh\\n')
""")
        (self.root / ".gitignore").write_text("__pycache__/\n")
        signer = self.base / "sdk/build-tools/36.0.0/apksigner"
        signer.parent.mkdir(parents=True)
        signer.write_text("#!/bin/sh\nexit 0\n")
        signer.chmod(0o755)
        self.env = {name: value for name, value in os.environ.items() if name not in CI_KEYS}
        self.env.update(ANDROID_HOME=str(self.base / "sdk"), TROPNIK_APK_OUTPUT=str(self.base / "dist"))

    def run_build(self, *, ci, catalogue="stale", terrain="stale"):
        (self.assets / "catalog.json").write_text(catalogue + "\n")
        (self.assets / "landscape.html").write_text(terrain + "\n")
        (self.assets / "custom-map.js").write_text("fresh\n")
        def git(*args):
            return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.DEVNULL, text=True).strip()
        git("init", "--initial-branch=main")
        git("add", ".")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Stale committed derivative")
        if ci:
            self.env.update(GITHUB_ACTIONS="true", GITHUB_SHA=git("rev-parse", "HEAD"), GITHUB_RUN_ID="123")
        return subprocess.run(["bash", str(self.root / "tools/android-build/build.sh")],
                              env=self.env, capture_output=True, text=True, timeout=20)

    def test_ci_rejects_stale_catalogue_before_any_generator_can_rewrite_it(self):
        result = self.run_build(ci=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fixture stale catalogue", result.stderr)
        self.assertEqual((self.assets / "catalog.json").read_text(), "stale\n")
        self.assertEqual((self.assets / "landscape.html").read_text(), "stale\n")
        self.assertNotIn("fixture stopped before Gradle", result.stdout + result.stderr)

    def test_ci_rejects_stale_terrain_without_repairing_it(self):
        result = self.run_build(ci=True, catalogue="fresh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fixture stale terrain", result.stderr)
        self.assertEqual((self.assets / "landscape.html").read_text(), "stale\n")
        self.assertNotIn("fixture stopped before Gradle", result.stdout + result.stderr)

    def test_local_build_still_generates_both_derivatives_before_test_stage(self):
        result = self.run_build(ci=False)
        self.assertNotEqual(result.returncode, 0)  # Deliberate fixture stop, no real SDK build.
        self.assertIn("fixture stopped before Gradle", result.stdout + result.stderr)
        self.assertEqual((self.assets / "catalog.json").read_text(), "fresh\n")
        self.assertEqual((self.assets / "landscape.html").read_text(), "fresh\n")


if __name__ == "__main__":
    unittest.main()
