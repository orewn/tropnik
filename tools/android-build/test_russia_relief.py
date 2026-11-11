"""Exercise country-overview package failures that otherwise leave offline gaps."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from asset_integrity import AssetError
from russia_relief import add_overview_sources, verify_overview


ROOT = Path(__file__).resolve().parents[2]
RELIEF = ROOT / "web/public/maps/russia-relief"
ASSETS = ROOT / "android/app/src/main/assets"


class RussiaOverviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest_bytes = (RELIEF / "manifest.json").read_bytes()
        cls.manifest = json.loads(cls.manifest_bytes)
        cls.provenance_bytes = (ROOT / "web/public/data/russia-boundaries-provenance.json").read_bytes()
        cls.tile = "4/0/4.png"  # canonical west-side tile required when the world wraps

    def read(self, relative):
        return (RELIEF / relative).read_bytes()

    def test_real_package_is_complete_local_and_matches_the_native_mask(self):
        report = verify_overview(self.manifest_bytes, self.read,
            actual_files=[str(path.relative_to(RELIEF)) for path in RELIEF.rglob("*") if path.is_file()],
            provenance_bytes=self.provenance_bytes)
        self.assertEqual(report["russiaOverviewTileCount"], 341)
        self.assertEqual(report["russiaOverviewTileBytesVerified"], 1689348)
        self.assertFalse(report["russiaOverviewIsElevationData"])
    def test_missing_corrupt_and_unlisted_assets_fail_instead_of_leaving_a_blank_edge(self):
        original = self.read(self.tile)
        with self.assertRaises(AssetError):
            verify_overview(self.manifest_bytes, lambda p: original[:-1] if p == self.tile else self.read(p))
        def missing(relative):
            if relative == self.tile:
                raise FileNotFoundError(relative)
            return self.read(relative)
        with self.assertRaises(AssetError):
            verify_overview(self.manifest_bytes, missing)
        actual = [str(path.relative_to(RELIEF)) for path in RELIEF.rglob("*") if path.is_file()]
        with self.assertRaises(AssetError):
            verify_overview(self.manifest_bytes, self.read, actual_files=actual + ["private-working-file.txt"])

    def test_revised_manifest_cannot_silently_remove_a_transparent_or_wrapped_tile(self):
        manifest = copy.deepcopy(self.manifest)
        removed = next(entry for entry in manifest["files"] if entry.get("transparent"))
        manifest["files"].remove(removed)
        manifest["tileCount"] -= 1
        manifest["totalTileBytes"] -= removed["bytes"]
        with self.assertRaisesRegex(AssetError, "cover every XYZ"):
            verify_overview(json.dumps(manifest).encode(), self.read)

    def test_remote_tile_template_wrong_zoom_or_different_mask_is_rejected(self):
        for mutation in [lambda value: value.update(tiles=["https://outside.invalid/{z}/{x}/{y}.png"]),
                         lambda value: value.update(maxzoom=5)]:
            tilejson = json.loads(self.read("tilejson.json")); mutation(tilejson)
            with self.assertRaisesRegex(AssetError, "TileJSON"):
                verify_overview(self.manifest_bytes,
                    lambda path: json.dumps(tilejson).encode() if path == "tilejson.json" else self.read(path),
                    provenance_bytes=self.provenance_bytes)
        with self.assertRaisesRegex(AssetError, "another RF display mask"):
            verify_overview(self.manifest_bytes, self.read, provenance_bytes=self.provenance_bytes + b"\n")

    def test_sources_notice_is_idempotent_and_preserves_existing_licences(self):
        previous = (ASSETS / "SOURCES.txt").read_bytes()
        updated = add_overview_sources(previous, self.manifest_bytes, self.read("ATTRIBUTION.txt"))
        self.assertEqual(add_overview_sources(updated, self.manifest_bytes, self.read("ATTRIBUTION.txt")), updated)
        for required in ["Tropnik Canvas", "Copernicus", "Manrope", "Natural Earth SR_50M", "ODbL-1.0"]:
            self.assertIn(required, updated.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
