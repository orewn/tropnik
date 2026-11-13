"""Source conservation and rejection gates for explicit editorial geometry."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('editorial_geometry', ROOT / 'web/scripts/prepare-editorial-geometry.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class EditorialGeometryTests(unittest.TestCase):
    def setUp(self):
        self.review = generator.read(ROOT / generator.REVIEW)

    def test_original_gpx_vertices_segments_and_reference_flags_survive(self):
        files = generator.build(ROOT)
        for item in self.review['accepted']:
            if item['kind'] != 'official_gpx':
                continue
            xml = ET.fromstring((ROOT / item['sourcePath']).read_bytes())
            segments = xml.findall('.//{*}trkseg') or xml.findall('.//{*}rte')
            original = [[[round(float(point.attrib['lon']), 7), round(float(point.attrib['lat']), 7)]
                         for point in segment if point.tag.split('}')[-1] in ('trkpt', 'rtept')]
                        for segment in segments]
            self.assertTrue(original, item['id'])
            feature = json.loads(files['web/public/data/routes/' + item['id'] + '.geojson'])['features'][0]
            self.assertEqual(feature['geometry']['coordinates'], original)
            self.assertEqual(feature['properties']['sourceUrl'], item['sourceUrl'])
            self.assertEqual(feature['properties']['license'], item['license'])
            for flag in ('geometryVerified', 'fieldVerified', 'navigationReady'):
                self.assertIs(feature['properties'][flag], False)

    def test_disconnected_gpx_segments_are_not_joined(self):
        lines = generator.parse_gpx(b'<gpx><trk><trkseg><trkpt lon="40" lat="50"/><trkpt lon="40.001" lat="50"/></trkseg><trkseg><trkpt lon="70" lat="55"/><trkpt lon="70.001" lat="55"/></trkseg></trk></gpx>')
        self.assertEqual(lines, [[[40, 50], [40.001, 50]], [[70, 55], [70.001, 55]]])
        self.assertLess(generator.line_metadata(lines)['geometryLengthKm'], 1)

    def test_changed_source_hash_title_or_endpoint_requires_new_review(self):
        for field, value in [('sourceSha256', '0' * 64), ('sourceTitle', 'A different itinerary'),
                             ('endpointAnchors', [{'coordinates': [0, 0], 'maximumDistanceM': 5}])]:
            with self.subTest(field=field):
                review = copy.deepcopy(self.review)
                review['accepted'][0][field] = value
                with self.assertRaises(ValueError):
                    generator.build(ROOT, review)

    def test_incomplete_state_inventory_or_duplicate_route_is_rejected(self):
        for mode in ('missing', 'duplicate', 'missing_reason'):
            with self.subTest(mode=mode):
                review = copy.deepcopy(self.review)
                if mode == 'missing':
                    review['unresolved'].pop()
                elif mode == 'duplicate':
                    review['unresolved'].append(review['unresolved'][0])
                else:
                    review['unresolved'][0].pop('reasonCode')
                with self.assertRaises(ValueError):
                    generator.build(ROOT, review)

    def test_schemes_and_unearned_verification_cannot_be_admitted(self):
        for mode in ('scheme', 'fieldVerified', 'navigationReady'):
            with self.subTest(mode=mode):
                review = copy.deepcopy(self.review)
                if mode == 'scheme':
                    review['accepted'][0]['geometryScope'] = 'source_scheme'
                else:
                    review['accepted'][0]['identityReview'][mode] = True
                with self.assertRaises(ValueError):
                    generator.build(ROOT, review)

    def test_generated_files_are_reproducible_from_pinned_sources(self):
        for relative, expected in generator.build(ROOT).items():
            self.assertEqual((ROOT / relative).read_bytes(), expected, relative)


if __name__ == '__main__':
    unittest.main()
