"""Exercise the actual offline asset gates, including realistic damaged packages."""
from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

from asset_integrity import AssetError, digest, verify_landscape, verify_terrain


ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "android/app/src/main/assets"
RUNTIME = ROOT / "data/terrain-pilot/runtime"
SPEC = importlib.util.spec_from_file_location("prepare_landscape", Path(__file__).with_name("prepare-landscape.py"))
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


class TerrainBundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest_bytes = (RUNTIME / "manifest.json").read_bytes()
        cls.manifest = json.loads(cls.manifest_bytes)
        cls.tile = next(entry["path"] for entry in cls.manifest["files"] if entry["path"].startswith("tiles/"))

    def read(self, path):
        return (RUNTIME / path).read_bytes()

    def test_actual_bundled_dem_covers_its_declared_area_and_has_licences(self):
        report = verify_terrain(self.manifest_bytes, self.read,
            actual_files=[str(path.relative_to(RUNTIME)) for path in RUNTIME.rglob("*") if path.is_file()])
        self.assertEqual(report["terrainTileCount"], 21)
        self.assertEqual(report["terrainGridSamples"], 129 * 129)

    def test_corrupt_and_missing_dem_tile_cannot_be_marked_ready(self):
        original = self.read(self.tile)
        altered = bytes([original[0] ^ 1]) + original[1:]
        for replacement in (altered, original[:-1]):
            with self.assertRaises(AssetError):
                verify_terrain(self.manifest_bytes, lambda path: replacement if path == self.tile else self.read(path))
        def missing(path):
            if path == self.tile:
                raise FileNotFoundError(path)
            return self.read(path)
        with self.assertRaises(AssetError):
            verify_terrain(self.manifest_bytes, missing)

    def test_removing_a_tile_from_an_otherwise_valid_manifest_does_not_hide_a_coverage_hole(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["files"] = [entry for entry in manifest["files"] if entry["path"] != self.tile]
        manifest["tileCount"] -= 1
        with self.assertRaisesRegex(AssetError, "cover"):
            verify_terrain(json.dumps(manifest).encode(), self.read)

    def test_path_traversal_duplicates_and_unlisted_files_are_rejected(self):
        for path in ("../outside.png", "/tmp/outside.png", "tiles/../../outside.png", "tiles\\outside.png"):
            manifest = copy.deepcopy(self.manifest)
            manifest["files"][0]["path"] = path
            with self.assertRaises(AssetError):
                verify_terrain(json.dumps(manifest).encode(), self.read)
        manifest = copy.deepcopy(self.manifest)
        manifest["files"].append(copy.deepcopy(manifest["files"][0]))
        with self.assertRaises(AssetError):
            verify_terrain(json.dumps(manifest).encode(), self.read)
        names = [entry["path"] for entry in self.manifest["files"]] + ["manifest.json", "private-working-file.txt"]
        with self.assertRaises(AssetError):
            verify_terrain(self.manifest_bytes, self.read, actual_files=names)


class LandscapeBundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.grid_bytes, cls.grid_provenance = PREPARE.verified_scene_grid(ROOT)

    def scene(self):
        return PREPARE.make_scene(RUNTIME, ROOT / "web/public/terrain/terrain-renderer.js",
                                 ASSETS / "maps/routes/route-11566519.geojson",
                                 grid_bytes=self.grid_bytes, grid_provenance=self.grid_provenance)[0]

    def verify(self, files):
        return verify_landscape(files["manifest.json"], files.__getitem__, (RUNTIME / "manifest.json").read_bytes())

    def test_identical_inputs_produce_identical_self_contained_documents(self):
        first, second = self.scene(), self.scene()
        self.assertEqual(first, second)
        self.assertTrue(self.verify(first)["landscapeOffline"])
        self.assertEqual(self.verify(first)["landscapeGridDimensions"], [513, 513])
        self.assertEqual(self.verify(first)["landscapeGridSamples"], 263169)

    def test_altered_derived_grid_is_not_embedded_with_an_old_proof(self):
        grid = json.loads(self.grid_bytes)
        grid["elevations"][0] += 1
        with self.assertRaisesRegex(AssetError, "differs from its proof"):
            PREPARE.make_scene(RUNTIME, ROOT / "web/public/terrain/terrain-renderer.js",
                               ASSETS / "maps/routes/route-11566519.geojson",
                               grid_bytes=json.dumps(grid).encode(), grid_provenance=self.grid_provenance)

    def test_manifest_cannot_relabel_the_embedded_grid_as_another_archive(self):
        files = self.scene()
        manifest = json.loads(files["manifest.json"])
        manifest["gridProvenance"]["inputManifest"]["sha256"] = "0" * 64
        files["manifest.json"] = json.dumps(manifest).encode()
        with self.assertRaisesRegex(AssetError, "another terrain archive"):
            self.verify(files)

    def test_missing_or_corrupt_scene_cannot_be_accepted(self):
        files = self.scene()
        del files["landscape.html"]
        with self.assertRaises(AssetError):
            self.verify(files)
        files = self.scene()
        files["landscape.html"] = files["landscape.html"][:-1]
        with self.assertRaises(AssetError):
            self.verify(files)

    def test_mismatched_terrain_package_is_rejected(self):
        files = self.scene()
        with self.assertRaisesRegex(AssetError, "another terrain"):
            verify_landscape(files["manifest.json"], files.__getitem__, b"{}")

    def test_changed_script_is_rejected_even_if_document_manifest_was_rehashed(self):
        files = self.scene()
        original = files["landscape.html"]
        files["landscape.html"] = original.replace(b"<script>", b"<script>window.sceneTampered=true;", 1)
        self.assertNotEqual(original, files["landscape.html"], "The integrity probe must actually alter a script")
        manifest = json.loads(files["manifest.json"])
        manifest["files"][0]["sizeBytes"] = len(files["landscape.html"])
        manifest["files"][0]["sha256"] = digest(files["landscape.html"])
        files["manifest.json"] = json.dumps(manifest).encode()
        with self.assertRaisesRegex(AssetError, "CSP"):
            self.verify(files)


if __name__ == "__main__":
    unittest.main()
