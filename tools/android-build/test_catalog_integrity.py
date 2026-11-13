"""Reject stale catalogue references and online URLs that would defeat local fallback."""
import copy
import json
from pathlib import Path
import unittest

from asset_integrity import AssetError, digest
from catalog_integrity import verify_catalog
from online_sources import verify_online_sources

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
        self.assertEqual(report["catalogReferenceRouteCount"], len(self.manifest["referenceRouteIds"]))
        self.assertEqual(report["catalogRegionCount"], len(self.manifest["regionIds"]))
        self.assertEqual(report["catalogReferenceOnlyRouteCount"], len(self.manifest.get("referenceOnlyRouteIds", [])))
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

    def test_shared_overview_cannot_be_missing_corrupted_or_reassigned_to_other_cards(self):
        path = self.manifest["trailOverlay"]["path"]
        with self.assertRaisesRegex(AssetError, "overview bytes changed"):
            verify_catalog(self.manifest_bytes, lambda name: self.read(name)[:-1] if name == path else self.read(name))
        changed = json.loads(self.read(path))
        changed["sources"][0]["ids"] = ["learning-route"]
        data = json.dumps(changed).encode()
        manifest = copy.deepcopy(self.manifest)
        manifest["trailOverlay"].update(bytes=len(data), sha256=digest(data))
        manifest["trailOverlay"]["url"] = "/data/trail-overlay-" + digest(data)[:16] + ".json"
        manifest["trailOverlay"]["sourcePath"] = "web/public" + manifest["trailOverlay"]["url"]
        with self.assertRaisesRegex(AssetError, "overview identity or geometry differs"):
            verify_catalog(json.dumps(manifest).encode(), lambda name: data if name == path else self.read(name))

    def test_empty_geometry_and_removed_source_inventory_cannot_be_rehashed_away(self):
        manifest = copy.deepcopy(self.manifest)
        record = manifest["files"][0]
        path = record["path"]
        empty = b'{"type":"FeatureCollection","features":[]}'
        record.update(bytes=len(empty), sha256=digest(empty))
        with self.assertRaisesRegex(AssetError, "no features"):
            verify_catalog(json.dumps(manifest).encode(), lambda p: empty if p == path else self.read(p))
        manifest = copy.deepcopy(self.manifest)
        manifest["sourceInputs"] = []
        with self.assertRaisesRegex(AssetError, "input inventory"):
            verify_catalog(json.dumps(manifest).encode(), self.read)

    def test_rehashed_catalog_cannot_promote_verification_or_invent_duration(self):
        for field, value in [("fieldVerified", True), ("navigationReady", True), ("durationMinutes", 60), ("regionIds", ["foreign-region"])]:
            catalog = json.loads(self.read("catalog.json"))
            catalog["routes"][0][field] = value
            changed = json.dumps(catalog).encode()
            manifest = copy.deepcopy(self.manifest)
            manifest["catalog"].update(bytes=len(changed), sha256=digest(changed))
            with self.assertRaises(AssetError):
                verify_catalog(json.dumps(manifest).encode(), lambda p: changed if p == "catalog.json" else self.read(p))

    def reference_fixture(self):
        catalog = json.loads(self.read("catalog.json"))
        route = copy.deepcopy(catalog["routes"][0])
        route.update(id="synthetic-reference-only", title="Синтетическая карточка для теста",
                     geometryAsset=None, center=None, bbox=None, geometryLengthKm=None,
                     distanceMeters=None, ascentMeters=None, durationMinutes=None, durationText=None,
                     sourceKind="community", sourceLicense="Описание с указанным источником.")
        catalog["routes"].append(route)
        manifest = copy.deepcopy(self.manifest)
        manifest["referenceRouteIds"].append(route["id"])
        manifest.setdefault("referenceOnlyRouteIds", []).append(route["id"])
        return catalog, manifest, route

    def verify_fixture(self, catalog, manifest):
        changed = json.dumps(catalog).encode()
        manifest["catalog"].update(bytes=len(changed), sha256=digest(changed))
        return verify_catalog(json.dumps(manifest).encode(), lambda p: changed if p == "catalog.json" else self.read(p))

    def test_explicit_geometry_free_card_preserves_source_card_without_fake_line(self):
        catalog, manifest, _ = self.reference_fixture()
        report = self.verify_fixture(catalog, manifest)
        self.assertEqual(report["catalogGeometryFilesVerified"], len(self.manifest["files"]))
        self.assertEqual(report["catalogReferenceOnlyRouteCount"], len(self.manifest.get("referenceOnlyRouteIds", [])) + 1)
        self.assertEqual(report["catalogReferenceRouteCount"], len(self.manifest["referenceRouteIds"]) + 1)

    def test_geometry_free_card_cannot_claim_a_location_or_geometry_licence(self):
        for field, value in [("center", [40, 43]), ("bbox", [40, 43, 41, 44]), ("inlineGeometry", "{}"),
                             ("geometryLengthKm", 1), ("sourceLicense", "© OpenStreetMap contributors")]:
            catalog, manifest, route = self.reference_fixture()
            route[field] = value
            with self.subTest(field=field), self.assertRaises(AssetError):
                self.verify_fixture(catalog, manifest)

    def test_dropped_geometry_is_not_silently_reclassified_as_unlocated_reference(self):
        catalog = json.loads(self.read("catalog.json"))
        route = next(route for route in catalog["routes"] if route.get("geometryAsset"))
        route.update(geometryAsset=None, center=None, bbox=None, geometryLengthKm=None, sourceLicense="Описание.")
        with self.assertRaises(AssetError):
            self.verify_fixture(catalog, copy.deepcopy(self.manifest))

    def test_manifest_and_catalogue_region_ids_must_match_exactly(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["regionIds"].append("foreign-region")
        with self.assertRaisesRegex(AssetError, "region parity"):
            verify_catalog(json.dumps(manifest).encode(), self.read)

    def test_territory_membership_requires_its_pinned_source_inputs(self):
        for omitted in ("tools/android-build/catalog-regions.mjs", "web/lib/territories.generated.json"):
            manifest = copy.deepcopy(self.manifest)
            manifest["sourceInputs"] = [record for record in manifest["sourceInputs"] if record["path"] != omitted]
            with self.subTest(omitted=omitted), self.assertRaisesRegex(AssetError, "membership source inputs"):
                verify_catalog(json.dumps(manifest).encode(), self.read)

    def test_rehashed_catalogue_cannot_reclassify_a_territory_as_a_tourism_direction(self):
        catalog = json.loads(self.read("catalog.json"))
        territory = next(region for region in catalog["regions"] if region["id"].startswith("territory-"))
        territory["territory"] = False
        with self.assertRaisesRegex(AssetError, "territory classification"):
            self.verify_fixture(catalog, copy.deepcopy(self.manifest))

    def test_additional_sources_cannot_smuggle_participants_or_wrong_message_identity(self):
        source = {"url": "https://t.me/poiskpohod/101", "name": "Сообщество poiskpohod", "messageId": 101,
                  "publishedAt": "2026-11-01T12:00:00", "reviewedAt": "2026-11-06", "scope": "community_mention"}
        catalog, manifest, route = self.reference_fixture()
        route["additionalSources"] = [source]
        self.verify_fixture(catalog, manifest)
        for change in [{"authorId": 123}, {"url": "https://t.me/poiskpohod/102"}, {"url": "file:///tmp/private"}]:
            catalog, manifest, route = self.reference_fixture()
            route["additionalSources"] = [{**source, **change}]
            with self.subTest(change=change), self.assertRaises(AssetError):
                self.verify_fixture(catalog, manifest)

    def test_online_sources_are_bounded_and_cannot_replace_local_resources(self):
        data = self.read("maps/online-sources.json")
        config = json.loads(data)
        report = verify_online_sources(data, self.read)
        self.assertTrue(report["bundledOfflineMapAvailable"])
        for mutation in (
            lambda value: value["sources"]["elevation"].update(tiles="https://example.invalid/{z}/{x}/{y}.png"),
            lambda value: value.update(glyphs="https://example.invalid/fonts/{fontstack}/{range}.pbf"),
            lambda value: value.update(fullRussiaDetailedOffline=True),
            lambda value: value["snapshots"]["vector"].update(assetPath="../private.json"),
        ):
            changed = copy.deepcopy(config); mutation(changed)
            with self.subTest(config=changed), self.assertRaises(AssetError):
                verify_online_sources((json.dumps(changed, ensure_ascii=False, indent=2) + "\n").encode(), self.read)


if __name__ == "__main__":
    unittest.main()
