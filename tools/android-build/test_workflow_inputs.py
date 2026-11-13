"""Keep trigger aliases and CI source provenance aligned with real build inputs."""
from pathlib import Path
import json
import re
import unittest

import preview_artifacts

ROOT = Path(__file__).resolve().parents[2]


class WorkflowInputsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = (ROOT / ".github/workflows/android.yml").read_text()
        cls.push = cls.workflow.split("  push:\n", 1)[1].split("  pull_request:\n", 1)[0]
        cls.patterns = re.findall(r"^      - '([^']+)'$", cls.push, re.M)

    def included(self, path):
        for pattern in self.patterns:
            self.assertRegex(pattern, r"^(?:[\w.-]+/)*[\w.-]+(?:/\*\*)?$")
            if pattern.endswith("/**") and path.startswith(pattern[:-2]):
                return True
            if path == pattern:
                return True
        return False

    def test_push_and_pull_request_share_one_path_list(self):
        self.assertIn("    branches: [main]\n", self.push)
        self.assertIn("    paths: &android_inputs\n", self.push)
        pull = self.workflow.split("  pull_request:\n", 1)[1].split("\npermissions:\n", 1)[0]
        self.assertEqual(pull, "    paths: *android_inputs\n")
        self.assertGreater(len(self.patterns), 0)

    def test_both_generated_manifests_and_clean_checkout_roots_are_triggered(self):
        for filename in ("android/app/src/main/assets/catalog-manifest.json",
                         "android/app/src/main/assets/custom-map/manifest.json"):
            manifest = json.loads((ROOT / filename).read_text())
            for item in manifest["sourceInputs"]:
                with self.subTest(path=item["path"]):
                    self.assertTrue(self.included(item["path"]))
        for path in preview_artifacts.SOURCE_INPUTS:
            probe = path + "/__ci_input__" if (ROOT / path).is_dir() else path
            with self.subTest(path=probe):
                self.assertTrue(self.included(probe))

    def test_preflight_dependencies_cannot_bypass_the_android_gate(self):
        for path in ("web/scripts/prepare-editorial-geometry.py",
                     "web/scripts/verify-custom-map.mjs", "web/tsconfig.json",
                     "tools/import-data/recover_route_coverage.py",
                     "tools/import-data/test_route_coverage_recovery.py",
                     "data/catalog/coverage-recovery/acquisition.json",
                     "data/catalog/national/import-report.json", ".gitignore"):
            with self.subTest(path=path):
                self.assertTrue(self.included(path))
        self.assertIn('--source-dir "$RUNNER_TEMP/tropnik-route-sources"', self.workflow)

    def test_unrelated_backend_and_released_download_link_do_not_rebuild_apks(self):
        for path in ("backend/internal/store/postgres.go", "infra/compose.yaml",
                     "docs/project-memory.md", "web/public/downloads/android-manifest.json"):
            with self.subTest(path=path):
                self.assertFalse(self.included(path))


if __name__ == "__main__":
    unittest.main()
