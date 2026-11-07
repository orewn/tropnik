#!/usr/bin/env python3
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


def points(value):
    if isinstance(value, list):
        if len(value) >= 2 and isinstance(value[0], (int, float)) and isinstance(value[1], (int, float)):
            yield value[0], value[1]
        else:
            for item in value:
                yield from points(item)


class RussiaMaskPartitionTest(unittest.TestCase):
    def check_mask(self, name):
        data = json.loads((ROOT / 'web/public/data' / name).read_text())
        self.assertGreater(len(data['features']), 100)
        for feature in data['features']:
            coordinates = list(points(feature['geometry']['coordinates']))
            self.assertTrue(coordinates)
            xs = [point[0] for point in coordinates]
            ys = [point[1] for point in coordinates]
            self.assertLessEqual(max(xs) - min(xs), 15.000001, feature['id'])
            self.assertLessEqual(max(ys) - min(ys), 15.000001, feature['id'])

    def test_display_and_canonical_masks_are_renderer_safe(self):
        self.check_mask('russia-outside-mask.geojson')
        self.check_mask('russia-canonical-mask.geojson')
        report = json.loads((ROOT / 'data/boundaries/russia-mask-checks.json').read_text())
        self.assertTrue(report['passed'])
        self.assertEqual(report['maskPartitionDegrees'], 15.0)
        self.assertLessEqual(report['maxMaskFeatureWidthDegrees'], 15.000001)
        self.assertLessEqual(report['maxMaskFeatureHeightDegrees'], 15.000001)


if __name__ == '__main__':
    unittest.main()
