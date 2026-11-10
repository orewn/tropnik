from __future__ import annotations

import copy
import json
import unittest

from asset_integrity import AssetError, digest
from map_coverage import add_coverage_style, decode, encoded, native_package, verify_coverage


def fixture():
    # Synthetic cells on opposite sides of the dateline. All coordinate roles
    # deliberately share one indexed ring, as in the sourced compact package.
    features = []
    for cell, indices in [("west", [0, 1, 2, 3, 0]), ("east", [4, 5, 6, 7, 4])]:
        for role in ["area", "mask", "territory", "territory-boundary"]:
            features.append({"type": "Feature", "id": cell + ":" + role,
                "properties": {"cell": cell, "role": role, "shapeID": "synthetic", "shapeName": "Synthetic", "fixtureLevel": "overview"},
                "geometry": {"type": "MultiLineString" if role == "territory-boundary" else "Polygon", "coordinates": [indices]}})
    coords = [(170, 50), (180, 50), (180, 60), (170, 60), (180, 50), (190, 50), (190, 60), (180, 60)]
    positions = []; previous = (0, 0)
    for pair in coords:
        point = tuple(round(value * 1e7) for value in pair)
        positions.extend([point[0] - previous[0], point[1] - previous[1]]); previous = point
    document = {"type": "TropnikCoverage", "encoding": "indexed-delta-1e7-v1", "coverageVersion": "0123456789abcdef",
                "lod": "overview", "positions": positions, "features": features}
    base = encoded(document)
    def receipt(path, data):
        return {"url": "/data/map-coverage/" + path, "bytes": len(data), "sha256": digest(data)}
    manifest = {"schemaVersion": 1, "version": document["coverageVersion"], "attribution": "Synthetic test fixture",
                "levels": [{"id": level, "maxZoom": zoom} for level, zoom in [("overview", 4), ("regional", 8), ("local", 12), ("source", 18)]],
                "cells": [{"id": cell, "bounds": bounds, "levels": {}} for cell, bounds in [("west", [170, 50, 180, 60]), ("east", [180, 50, 190, 60])]],
                "base": receipt("base.coverage", base)}
    files = {"base.coverage": base}
    for cell in manifest["cells"]:
        for level in ["regional", "local", "source"]:
            detailed = [copy.deepcopy(feature) for feature in features if feature["properties"]["cell"] == cell["id"]]
            for feature in detailed:
                feature["properties"]["fixtureLevel"] = level
            value = {**document, "cell": cell["id"], "lod": level, "features": detailed}
            path = "cells/" + cell["id"] + level + ".coverage"; data = encoded(value)
            files[path] = data; cell["levels"][level] = receipt(path, data)
    return encoded(manifest), files


class NativeCoverageTests(unittest.TestCase):
    def test_source_cells_are_byte_exact_and_only_eastern_cell_moves_to_canonical_world(self):
        source, inputs = fixture()
        files = native_package(source, inputs.__getitem__)
        for path, data in inputs.items():
            self.assertEqual(data, files[path])
        base = json.loads(files["native-base.geojson"])
        west = next(f for f in base["features"] if f["id"] == "west:area")
        east = next(f for f in base["features"] if f["id"] == "east:area")
        self.assertEqual(west["geometry"]["coordinates"][0][0], [170, 50])
        self.assertEqual(east["geometry"]["coordinates"][0][0], [-180, 50])
        self.assertEqual(east["geometry"]["coordinates"][0][1], [-170, 50])
        report = verify_coverage(files["manifest.json"], files.__getitem__, actual_files=files)
        self.assertTrue(report["mapCoverageAllLevelsBundled"])
        self.assertEqual(report["mapCoverageFilesVerified"], len(files))

    def test_rehashed_native_overview_cannot_diverge_from_shared_cells(self):
        source, inputs = fixture(); files = native_package(source, inputs.__getitem__)
        manifest = json.loads(files["manifest.json"])
        base = json.loads(files["native-base.geojson"]); base["features"].pop()
        files["native-base.geojson"] = encoded(base)
        manifest["nativeBase"].update(bytes=len(files["native-base.geojson"]), sha256=digest(files["native-base.geojson"]))
        files["manifest.json"] = encoded(manifest)
        with self.assertRaisesRegex(AssetError, "sourced canonical"):
            verify_coverage(files["manifest.json"], files.__getitem__)

    def test_corrupt_missing_unlisted_and_path_traversal_assets_fail_closed(self):
        source, inputs = fixture(); valid = native_package(source, inputs.__getitem__)
        damaged = dict(valid); damaged["cells/westsource.coverage"] += b" "
        with self.assertRaisesRegex(AssetError, "asset changed"):
            verify_coverage(damaged["manifest.json"], damaged.__getitem__)
        with self.assertRaisesRegex(AssetError, "Unlisted or missing"):
            verify_coverage(valid["manifest.json"], valid.__getitem__, actual_files=[*valid, "unlisted.coverage"])
        manifest = json.loads(source); manifest["base"]["url"] = "/data/map-coverage/../outside.coverage"
        with self.assertRaises(AssetError):
            native_package(encoded(manifest), inputs.__getitem__)
        for change in [lambda d: d["positions"].append(0), lambda d: d["positions"].__setitem__(0, .5),
                       lambda d: d["features"][0]["geometry"]["coordinates"][0].__setitem__(0, 100000)]:
            document = json.loads(inputs["base.coverage"]); change(document)
            with self.assertRaises(AssetError):
                decode(encoded(document), json.loads(source))

    def test_all_native_display_roles_use_one_initially_populated_source(self):
        source, inputs = fixture(); files = native_package(source, inputs.__getitem__)
        original = {"sources": {}, "layers": [{"id": key, "source": "legacy", "type": "fill"} for key in ["land", "borders", "admin-boundary-lines", "russia-outside-mask"]]}
        style = add_coverage_style(copy.deepcopy(original), files["manifest.json"])
        verify_coverage(files["manifest.json"], files.__getitem__, style=style)
        self.assertEqual(len({layer["source"] for layer in style["layers"]}), 1)
        self.assertEqual(len(original["layers"]), 4)
        self.assertNotIn("borders", [layer["id"] for layer in style["layers"]])


if __name__ == "__main__":
    unittest.main()
