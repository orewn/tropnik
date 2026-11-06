"""Geometry/data regression checks; no network and no fabricated trail approval."""
import importlib.util
import json
import math
from pathlib import Path
import re
import unittest

from shapely.geometry import LineString, Point, Polygon, shape

MODULE_PATH = Path(__file__).with_name('build-territories.py')
SPEC = importlib.util.spec_from_file_location('territory_builder', MODULE_PATH)
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class TerritoryDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = json.loads(builder.INDEX_PATH.read_bytes())
        cls.collection = json.loads(builder.GEOMETRY_PATH.read_bytes())
        cls.features = {feature['id']: feature for feature in cls.collection['features']}
        cls.polygons = {key: shape(feature['geometry']) for key, feature in cls.features.items()}

    def test_all_selected_polygons_and_original_provenance_are_retained(self):
        territories = self.index['territories']
        self.assertEqual(len(territories), 85)
        self.assertEqual(len(self.features), 85)
        self.assertEqual({item['id'] for item in territories}, set(self.features))
        self.assertEqual(sum(f['properties']['shapeGroup'] == 'RUS' for f in self.features.values()), 83)
        ukr = [f['properties'] for f in self.features.values() if f['properties']['shapeGroup'] == 'UKR']
        self.assertEqual({item['shapeName'] for item in ukr}, {'Autonomous Republic of Crimea', 'Sevastopol'})
        self.assertEqual({item['shapeISO'] for item in ukr}, {'UA-43', 'UA-40'})
        for item in territories:
            polygon = self.polygons[item['id']]
            properties = self.features[item['id']]['properties']
            self.assertTrue(polygon.is_valid and not polygon.is_empty, item['name'])
            self.assertEqual(item['id'], 'territory-' + properties['shapeID'])
            self.assertEqual(item['shapeNames'], [properties['shapeName']])
            self.assertEqual(item['name'], builder.RUSSIAN_NAMES[properties['shapeName']])
            self.assertFalse(properties['legalBoundaryClaim'])
            self.assertFalse(properties['navigationReady'])
            self.assertTrue(polygon.covers(Point(item['center'])), item['name'])
            for recorded, actual in zip(item['bounds'], polygon.bounds, strict=True):
                self.assertAlmostEqual(recorded, actual, places=6)

    def test_chukotka_is_continuous_and_dateline_union_preserves_source_area(self):
        item = next(item for item in self.index['territories'] if 'Chukotka Autonomous Okrug' in item['shapeNames'])
        west, south, east, north = item['bounds']
        self.assertLess(east - west, 40)
        self.assertGreater(west, 150)
        self.assertGreater(east, 180)
        self.assertLess(east, 200)
        self.assertLess(south, north)
        original = next(f for f in json.loads((builder.PUBLIC / 'data/regions.geojson').read_bytes())['features']
                        if f['properties']['shapeName'] == 'Chukotka Autonomous Okrug')
        unwrapped = builder.normalize_geometry(shape(original['geometry']))
        self.assertAlmostEqual(unwrapped.area, self.polygons[item['id']].area, places=10)
        self.assertTrue(self.features[item['id']]['properties']['datelineSeamJoined'])
        self.assertEqual(builder.russia_longitude(-179), builder.russia_longitude(181))
        # Python round uses different half ties; match JavaScript Math.round.
        self.assertEqual(builder.russia_longitude(-75), 285)
        for polygon in builder.polygon_parts(self.polygons[item['id']]):
            for ring in [polygon.exterior, *polygon.interiors]:
                points = list(ring.coords)
                self.assertTrue(all(abs(a[0] - b[0]) < 180 for a, b in zip(points, points[1:])))

    def test_membership_detects_crossing_segments_without_inside_vertices_and_respects_holes(self):
        across_dateline = builder.normalize_geometry(Polygon([(179, 1), (-179, 1), (-179, 3), (179, 3)]))
        crossing = builder.normalize_geometry(LineString([(178, 2), (-178, 2)]))
        self.assertFalse(across_dateline.covers(Point(crossing.coords[0])))
        self.assertFalse(across_dateline.covers(Point(crossing.coords[-1])))
        with_hole = Polygon([(0, 0), (4, 0), (4, 4), (0, 4)], [[(1, 1), (3, 1), (3, 3), (1, 3)]])
        inside_hole = LineString([(1.5, 2), (2.5, 2)])
        touches_boundary = LineString([(4, 1), (5, 1)])
        self.assertEqual(builder.memberships([across_dateline, with_hole], [crossing, inside_hole, touches_boundary]), [[0], [2]])

    def test_actual_geometry_urls_hashes_and_intersections_match_both_local_source_directories(self):
        sources, routes = builder.load_routes()
        self.assertEqual(self.index['metadata']['membershipMethod'], 'exact-segment-polygon-intersection')
        self.assertEqual(self.index['metadata']['routeGeometrySourceCount'], len(sources))
        self.assertEqual(self.index['metadata']['routeGeometrySources'], sources)
        self.assertEqual({source['url'].split('/')[2] for source in sources}, {'routes', 'imported'})
        membership = {item['id']: set(item['geometryUrls']) for item in self.index['territories']}
        all_urls = {source['url'] for source in sources}
        self.assertEqual(len(all_urls), len(sources))
        for values in membership.values():
            self.assertLessEqual(values, all_urls)
        multi_territory_route_found = False
        for source, route in zip(sources, routes, strict=True):
            expected = {key for key, polygon in self.polygons.items() if polygon.intersects(route)}
            actual = {key for key, urls in membership.items() if source['url'] in urls}
            self.assertEqual(actual, expected, source['url'])
            multi_territory_route_found |= len(actual) > 1
        self.assertTrue(multi_territory_route_found, 'Cross-territory source lines must belong to each intersected polygon')

    def test_all_outlines_fit_the_shared_viewbox_and_retain_components_and_holes(self):
        self.assertEqual(self.index['viewBox'], '0 0 100 100')
        self.assertEqual(self.index['metadata']['outline']['fillRule'], 'evenodd')
        for item in self.index['territories']:
            path = item['outline']
            self.assertRegex(path, r'^M[0-9.,LZM]+Z$')
            ring_count = sum(1 + len(part.interiors) for part in builder.polygon_parts(self.polygons[item['id']]))
            self.assertEqual(path.count('M'), ring_count, item['name'])
            values = [float(number) for number in re.findall(r'\d+\.\d+', path)]
            self.assertTrue(values and all(math.isfinite(value) and 5.99 <= value <= 94.01 for value in values), item['name'])

    def test_artifacts_are_byte_reproducible_and_geometry_digest_is_correct(self):
        index, geometry = builder.build()
        self.assertEqual(builder.encoded(index), builder.INDEX_PATH.read_bytes())
        self.assertEqual(builder.encoded(geometry), builder.GEOMETRY_PATH.read_bytes())
        record = index['geometry']
        self.assertEqual(record['sha256'], builder.sha256(builder.GEOMETRY_PATH.read_bytes()))
        self.assertEqual(record['bytes'], builder.GEOMETRY_PATH.stat().st_size)
        self.assertEqual(record['features'], 85)


if __name__ == '__main__':
    unittest.main()
