#!/usr/bin/env python3
"""Regression for source-detail protection silently omitting new route catalogues."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('route_catalog_inputs', Path(__file__).with_name('route_catalog_inputs.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
ROOT = Path(__file__).resolve().parents[2]


def route(identifier, start=20):
    return {'type': 'Feature', 'properties': {'id': identifier},
            'geometry': {'type': 'MultiLineString', 'coordinates': [[[start, 60], [start + .01, 60.01]]]}}


def collection(root, relative, features):
    path = root / 'data/catalog' / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'type': 'FeatureCollection', 'features': features}))
    return path


class RouteCatalogueInputsTest(unittest.TestCase):
    def test_national_and_later_catalogues_participate_without_editing_builder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = route('old')
            collection(root, 'routes.geojson', [original])
            national = collection(root, 'national/routes.geojson', [route('national', 30)])
            features, receipt = MODULE.load_route_catalogs(root)
            self.assertEqual({feature['properties']['id'] for feature in features}, {'old', 'national'})
            self.assertEqual(receipt['routeCount'], 2)
            self.assertEqual(len(receipt['catalogInputs']), 2)
            # Every new region is protected, without a static path/count allowlist.
            collection(root, 'reviewed-extra/routes.geojson', [route('new', 40)])
            extended, after = MODULE.load_route_catalogs(root)
            self.assertEqual({feature['properties']['id'] for feature in extended}, {'old', 'national', 'new'})
            self.assertNotEqual(receipt['catalogSha256'], after['catalogSha256'])
            # A source-byte change is visible even when the route identity stays.
            national.write_text(national.read_text() + '\n')
            self.assertNotEqual(after['catalogSha256'], MODULE.load_route_catalogs(root)[1]['catalogSha256'])
            collection(root, 'raw/provider/routes.geojson', [route('unreviewed', 50)])
            self.assertEqual(MODULE.load_route_catalogs(root)[1]['routeCount'], 3)

    def test_duplicate_identity_cannot_silently_replace_geometry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = route('same')
            collection(root, 'routes.geojson', [original])
            collection(root, 'national/routes.geojson', [original])
            self.assertEqual(MODULE.load_route_catalogs(root)[1]['routeCount'], 1)
            collection(root, 'national/routes.geojson', [route('same', 40)])
            with self.assertRaisesRegex(ValueError, 'Conflicting route geometry'):
                MODULE.load_route_catalogs(root)
            collection(root, 'national/routes.geojson', [original, original])
            with self.assertRaisesRegex(ValueError, 'Duplicate route identity'):
                MODULE.load_route_catalogs(root)

    def test_current_national_routes_are_in_shared_source_input(self):
        routes, receipt = MODULE.load_route_catalogs(ROOT)
        ids = {feature['properties']['id'] for feature in routes}
        national = json.loads((ROOT / 'data/catalog/national/routes.geojson').read_text())['features']
        self.assertTrue(national)
        self.assertTrue({feature['properties']['id'] for feature in national}.issubset(ids))
        self.assertEqual(receipt['routeCount'], len(ids))
        self.assertEqual(sum(row['routeCount'] for row in receipt['catalogInputs']), len(routes))

    def test_invalid_line_inputs_cannot_create_misleading_detail_windows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            invalid = [
                {'type': 'LineString', 'coordinates': []},
                {'type': 'LineString', 'coordinates': [[20, 60]]},
                {'type': 'LineString', 'coordinates': [[20, 60], [float('nan'), 61]]},
                {'type': 'GeometryCollection', 'geometries': [{'type': 'Point', 'coordinates': [20, 60]}]},
            ]
            for geometry in invalid:
                feature = route('bad'); feature['geometry'] = geometry
                collection(root, 'routes.geojson', [feature])
                with self.assertRaisesRegex(ValueError, 'Invalid or non-linear'):
                    MODULE.load_route_catalogs(root)


if __name__ == '__main__':
    unittest.main()
