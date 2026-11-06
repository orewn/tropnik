"""Reject stale catalogue references and online URLs that would defeat local fallback."""
import copy
import json
from pathlib import Path
import unittest

from asset_integrity import AssetError, digest
from catalog_integrity import verify_catalog, verify_map_resources

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "android/app/src/main/assets"


class CatalogIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.manifest_bytes = (ASSETS / "catalog-manifest.json").read_bytes()
        self.manifest = json.loads(self.manifest_bytes)

    def read(self, path):
        return (ASSETS / path).read_bytes()

    def test_real_catalog_matches_all_web_geometry_bytes_and_inputs(self):
        report = verify_catalog(self.manifest_bytes, self.read,
            actual_geometry=[str(p.relative_to(ASSETS)) for p in (ASSETS / "maps/routes").glob("*.geojson")],
            source_read=lambda path: (ROOT / path).read_bytes())
        self.assertEqual(report["catalogReferenceRouteCount"], 277)
        self.assertEqual(report["catalogRegionCount"], 6)
        self.assertTrue(report["catalogSourceByteParityVerified"])

    def test_missing_changed_and_unlisted_geometry_is_rejected(self):
        path = self.manifest["files"][0]["path"]
        original = self.read(path)
        with self.assertRaisesRegex(AssetError, "bytes changed"):
            verify_catalog(self.manifest_bytes, lambda p: original[:-1] if p == path else self.read(p))
        def missing(p):
            if p == path:
                raise FileNotFoundError(p)
            return self.read(p)
        with self.assertRaisesRegex(AssetError, "Missing route"):
            verify_catalog(self.manifest_bytes, missing)
        with self.assertRaisesRegex(AssetError, "stale"):
            verify_catalog(self.manifest_bytes, self.read, actual_geometry=[r["path"] for r in self.manifest["files"]] + ["maps/routes/stale.geojson"])

    def test_rehashed_catalog_cannot_promote_verification_or_invent_duration(self):
        for field, value in [("fieldVerified", True), ("navigationReady", True), ("durationMinutes", 60), ("regionIds", ["foreign-region"])]:
            catalog = json.loads(self.read("catalog.json"))
            catalog["routes"][0][field] = value
            changed = json.dumps(catalog).encode()
            manifest = copy.deepcopy(self.manifest)
            manifest["catalog"].update(bytes=len(changed), sha256=digest(changed))
            with self.assertRaises(AssetError):
                verify_catalog(json.dumps(manifest).encode(), lambda p: changed if p == "catalog.json" else self.read(p))

    def test_online_sources_are_bounded_and_cannot_replace_local_resources_or_mask(self):
        style = json.loads(self.read("maps/style.json"))
        report = verify_map_resources(style)
        self.assertTrue(report["bundledOfflineMapAvailable"])
        for mutation in (
            lambda s: s["sources"]["online-dem"].update(tiles=["https://example.invalid/{z}/{x}/{y}.png"]),
            lambda s: s.update(glyphs="https://example.invalid/fonts/{fontstack}/{range}.pbf"),
            lambda s: s["layers"].insert(0, s["layers"].pop()),
            lambda s: next(l for l in s["layers"] if l["id"] == "online-hillshade").update(minzoom=0),
        ):
            changed = copy.deepcopy(style)
            mutation(changed)
            with self.assertRaises(AssetError):
                verify_map_resources(changed)


if __name__ == "__main__":
    unittest.main()
