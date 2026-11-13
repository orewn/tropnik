#!/usr/bin/env python3
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from shapely.geometry import Polygon, box

SPEC = importlib.util.spec_from_file_location('coverage_recovery', Path(__file__).with_name('recover_route_coverage.py'))
RECOVERY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECOVERY)


class CoverageRecoveryTests(unittest.TestCase):
    def test_coarse_rejection_recovers_only_the_whole_line_inside_full_source(self):
        # Both endpoints of route 2 lie inside the source, but its segment
        # crosses an actual excluded hole. Checking only points would admit it.
        full = Polygon([(29, 49), (33, 49), (33, 53), (29, 53)],
                       [[(30.4, 50.4), (30.6, 50.4), (30.6, 50.6), (30.4, 50.6)]])
        source = {'path': 'raw/relations/1.json', 'sourceUrl': RECOVERY.NATIONAL.BASE + '/details/relation/1',
                  'sha256': 'a' * 64, 'retrievedAt': '2026-11-13T00:00:00+00:00'}
        region = {'id': 'territory-source', 'shape': full}
        def relation(ident, coordinates):
            return {'id': ident, 'tags': {'route': 'hiking', 'name': 'Actual source line'},
                    'route': [{'id': 1, 'route_type': 'base', 'geometry': {'type': 'LineString',
                              'coordinates': [RECOVERY.NATIONAL.WMT.merc(*point) for point in coordinates]}}]}
        valid = relation(1, [[30, 50], [30.2, 50.2]])
        old_coarse = box(30.1, 50.1, 32, 52)
        with patch.object(RECOVERY.NATIONAL, 'destination_memberships', return_value=[]):
            self.assertIsNone(RECOVERY.NATIONAL.normalize(1, valid, source, [region], old_coarse)[0])
            restored, reason = RECOVERY.NATIONAL.normalize(1, valid, source, [region], full)
            self.assertIsNone(reason)
            self.assertEqual(restored['geometry']['coordinates'], [[[30, 50], [30.2, 50.2]]])
            crossing, reason = RECOVERY.NATIONAL.normalize(2, relation(2, [[30, 50], [31, 51]]), source, [region], full)
            self.assertIsNone(crossing)
            self.assertEqual(reason, 'not_wholly_inside_existing_display_coverage')
            self.assertFalse(restored['properties']['fieldVerified'])
            self.assertFalse(restored['properties']['navigationReady'])

    def fixture(self, directory):
        root = Path(directory)
        baseline = root / 'baseline.json'
        baseline.write_text(json.dumps({'rejected': [{'osmId': 1, 'reason': 'not_wholly_inside_existing_display_coverage'}]}))
        raw = root / 'raw/relations/1.json'; raw.parent.mkdir(parents=True)
        raw.write_text('{"id":1,"tags":{"route":"hiking"}}')
        metadata = {'path': 'raw/relations/1.json', 'sourceUrl': RECOVERY.NATIONAL.BASE + '/details/relation/1',
                    'retrievedAt': '2026-11-13T00:00:00+00:00', 'sha256': hashlib.sha256(raw.read_bytes()).hexdigest(),
                    'bytes': raw.stat().st_size, 'license': 'ODbL-1.0'}
        raw.with_suffix('.json.source.json').write_text(json.dumps({key: value for key, value in metadata.items() if key != 'path'}))
        acquisition = {'complete': True, 'selectedCandidates': [1], 'baselineImportReportSha256': RECOVERY.sha(baseline.read_bytes()),
                       'sources': [{'osmId': 1, **metadata}], 'errors': []}
        return root, baseline, raw, acquisition

    def test_membership_uses_the_exact_full_source_territory_without_changing_identity(self):
        coarse = {'id': 'territory-one', 'name': 'Reviewed name', 'shapeNames': ['Source name'], 'shape': box(30.1, 50.1, 32, 52)}
        full = {'id': 'territory-one', 'shapeName': 'Source name', 'shape': box(30, 50, 32, 52)}
        restored = RECOVERY.source_territories([coarse], [full])[0]
        self.assertEqual(restored['id'], coarse['id'])
        self.assertEqual(restored['name'], coarse['name'])
        self.assertTrue(restored['shape'].covers(box(30.01, 50.01, 30.02, 50.02)))
        self.assertFalse(coarse['shape'].intersects(box(30.01, 50.01, 30.02, 50.02)))
        for invalid in [[], [{**full, 'id': 'territory-nearby'}], [full, full]]:
            with self.assertRaisesRegex(ValueError, 'identities'):
                RECOVERY.source_territories([coarse], invalid)
        with self.assertRaisesRegex(ValueError, 'name differs'):
            RECOVERY.source_territories([coarse], [{**full, 'shapeName': 'Different source name'}])

    def test_deterministic_archive_rehydrates_exact_new_bytes_and_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root, baseline, raw, acquisition = self.fixture(directory)
            with patch.object(RECOVERY, 'BASELINE', baseline):
                RECOVERY.checked_sources(root, acquisition)
                archive, count = RECOVERY.source_archive(root, acquisition)
                self.assertEqual(archive, RECOVERY.source_archive(root, acquisition)[0])
                path = root / 'source-responses.tar.gz'; path.write_bytes(archive)
                destination = root / 'rehydrated'
                RECOVERY.unpack_archive(path, destination, {'bytes': len(archive), 'sha256': RECOVERY.sha(archive), 'files': count})
                self.assertEqual((destination / 'raw/relations/1.json').read_bytes(), raw.read_bytes())
                self.assertEqual(RECOVERY.read(destination / 'acquisition.json'), acquisition)
                raw.write_text('{"id":2}')
                with self.assertRaisesRegex(ValueError, 'response or acquisition sidecar changed'):
                    RECOVERY.checked_sources(root, acquisition)

    def test_acquisition_must_account_for_every_original_candidate_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root, baseline, _, acquisition = self.fixture(directory)
            with patch.object(RECOVERY, 'BASELINE', baseline):
                acquisition['errors'] = [{'osmId': 1, 'error': 'timeout'}]
                with self.assertRaisesRegex(ValueError, 'accounting'):
                    RECOVERY.checked_sources(root, acquisition)
                acquisition['sources'] = []
                self.assertEqual(RECOVERY.checked_sources(root, acquisition), [])
                acquisition['errors'] = []
                with self.assertRaisesRegex(ValueError, 'accounting'):
                    RECOVERY.checked_sources(root, acquisition)


if __name__ == '__main__':
    unittest.main()
