import importlib.util
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from shapely.geometry import box, Polygon, MultiPolygon

spec = importlib.util.spec_from_file_location('national', Path(__file__).with_name('import_national_waymarked.py'))
national = importlib.util.module_from_spec(spec)
spec.loader.exec_module(national)
audit_spec = importlib.util.spec_from_file_location('national_audit', Path(__file__).with_name('audit_national_catalog.py'))
auditor = importlib.util.module_from_spec(audit_spec)
audit_spec.loader.exec_module(auditor)


def relation(ident, lines, tags=None):
    return {'id': ident, 'tags': tags or {'name': 'Исходная тропа', 'route': 'hiking'},
            'route': [{'id': index + 1, 'route_type': 'base',
                       'geometry': {'type': 'LineString', 'coordinates': [national.WMT.merc(*p) for p in line]}}
                      for index, line in enumerate(lines)]}


class NationalSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.region = {'id': 'territory-realB1', 'shape': box(29, 49, 33, 53)}
        self.source = {'path': 'raw/relations/1.json', 'sourceUrl': national.BASE + '/details/relation/1',
                       'sha256': 'a' * 64, 'retrievedAt': '2026-11-10T00:00:00+00:00'}

    def test_original_disconnected_members_stay_separate_and_unverified(self):
        lines = [[[30, 50], [30.1, 50.1]], [[31, 51], [31.2, 51.1]]]
        feature, reason = national.normalize(1, relation(1, lines), self.source, [self.region], self.region['shape'])
        self.assertIsNone(reason)
        self.assertEqual(feature['geometry']['coordinates'], lines)
        props = feature['properties']
        self.assertEqual(props['territoryIds'], ['territory-realB1'])
        self.assertEqual(props['pointCount'], 4)
        self.assertEqual(props['segmentCount'], 2)
        self.assertEqual(props['publicationStatus'], 'reference')
        for key in ['navigationReady', 'fieldVerified', 'accessPermissionVerified', 'indexable']:
            self.assertFalse(props[key])
        self.assertIsNone(props['officialDistanceKm'])
        self.assertIsNone(props['conditionsVerifiedAt'])

    def test_line_crossing_unselected_hole_rejected_even_with_inside_endpoints(self):
        area = Polygon([(29,49),(33,49),(33,53),(29,53)], [[(30.4,50.4),(30.6,50.4),(30.6,50.6),(30.4,50.6)]])
        feature, reason = national.normalize(1, relation(1, [[[30,50],[31,51]]]), self.source, [self.region], area)
        self.assertIsNone(feature)
        self.assertEqual(reason, 'not_wholly_inside_existing_display_coverage')

    def test_outside_geometry_never_clipped_or_moved_into_russia(self):
        feature, reason = national.normalize(1, relation(1, [[[28,50],[30,50]]]), self.source, [self.region], self.region['shape'])
        self.assertIsNone(feature)
        self.assertEqual(reason, 'not_wholly_inside_existing_display_coverage')

    def test_dateline_query_is_split_without_enumerating_the_rest_of_world(self):
        extents = national.query_extents(box(170, 60, 190, 70))
        self.assertEqual(extents, [[170,60,180,70], [-180,60,-170,70]])
        self.assertTrue(national.query_overlaps(box(170,60,190,70), [-179,62,-175,68]))

    def test_western_hemisphere_segment_keeps_original_coordinates(self):
        lines = [[[-175,65],[-174.9,65.1]]]
        area = box(180, 60, 190, 70)
        region = {'id': 'territory-chukotka', 'shape': area}
        feature, reason = national.normalize(1, relation(1, lines), self.source, [region], area)
        self.assertIsNone(reason)
        self.assertEqual(feature['geometry']['coordinates'], lines)

    def test_wrapped_member_requires_review_instead_of_world_spanning_line(self):
        with self.assertRaisesRegex(ValueError, 'Dateline-crossing'):
            national.normalized_lines(relation(1, [[[179,65],[-179,65]]]))

    def test_other_transport_or_wrong_source_identity_is_not_hiking(self):
        feature, reason = national.normalize(1, relation(1, [[[30,50],[31,51]]], {'route':'bicycle'}), self.source, [self.region], self.region['shape'])
        self.assertIsNone(feature)
        self.assertEqual(reason, 'route_type_not_hiking_foot_or_walking')
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            national.normalize(2, relation(1, [[[30,50],[31,51]]]), self.source, [self.region], self.region['shape'])

    def test_cached_sources_must_match_url_size_and_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = b'{"id":1}'
            path = root / 'raw.json'
            path.write_bytes(payload)
            meta = {'sourceUrl':'https://example.invalid/a', 'bytes':len(payload), 'sha256':national.sha(payload), 'retrievedAt':'old'}
            sidecar = path.with_suffix('.json.source.json')
            sidecar.write_text(json.dumps(meta))
            with patch.object(national, 'OUT', root):
                value, source = national.fetch_json(meta['sourceUrl'], Path('raw.json'))
                self.assertEqual(value, {'id':1})
                self.assertEqual(source['retrievedAt'], 'old')
                with self.assertRaisesRegex(ValueError, 'identity/hash mismatch'):
                    national.fetch_json('https://example.invalid/b', Path('raw.json'))
                path.write_bytes(b'{"id":2}')
                with self.assertRaisesRegex(ValueError, 'identity/hash mismatch'):
                    national.fetch_json(meta['sourceUrl'], Path('raw.json'))


class SourceArchiveTests(unittest.TestCase):
    def make_archive(self, root, name='raw/relations/1.json', symlink=False):
        payload = b'{"id":1}'
        for filename in ['discovery.json','import-report.json']:
            (root / filename).write_text('{}')
        manifest = {'discoverySha256':auditor.sha(root/'discovery.json'),
                    'importReportSha256':auditor.sha(root/'import-report.json'),
                    'files':[{'path':name,'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}]}
        manifest_bytes = json.dumps(manifest).encode()
        archive_path = root / 'sources.tar.gz'
        with tarfile.open(archive_path,'w:gz') as archive:
            item = tarfile.TarInfo('source-snapshot.json')
            item.size = len(manifest_bytes)
            archive.addfile(item,io.BytesIO(manifest_bytes))
            item = tarfile.TarInfo(name)
            if symlink:
                item.type = tarfile.SYMTYPE
                item.linkname = '/tmp/forbidden-target'
                archive.addfile(item)
            else:
                item.size = len(payload)
                archive.addfile(item,io.BytesIO(payload))
        (root/'source-archive.json').write_text(json.dumps({'bytes':archive_path.stat().st_size,
            'sha256':auditor.sha(archive_path),'sourceFiles':1,
            'manifestSha256':hashlib.sha256(manifest_bytes).hexdigest()}))
        return archive_path, payload

    def test_archive_rehydrates_original_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, payload = self.make_archive(root)
            with patch.object(auditor,'OUT',root):
                auditor.unpack_source_archive(archive,root/'unpacked')
            self.assertEqual((root/'unpacked/raw/relations/1.json').read_bytes(),payload)

    def test_hash_pinned_archive_cannot_escape_the_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for path in ['raw/../../escaped.json','raw//relations/1.json','raw/relations/../1.json','raw/relations/..\\1.json','raw/C:1.json']:
                with self.subTest(path=path):
                    archive, _ = self.make_archive(root,path)
                    with patch.object(auditor,'OUT',root), self.assertRaisesRegex(ValueError,'Unsafe source archive'):
                        auditor.unpack_source_archive(archive,root/'unpacked')
            self.assertFalse((root/'escaped.json').exists())

    def test_hash_pinned_archive_still_rejects_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, _ = self.make_archive(root,symlink=True)
            with patch.object(auditor,'OUT',root), self.assertRaisesRegex(ValueError,'Unsafe source archive'):
                auditor.unpack_source_archive(archive,root/'unpacked')

    def test_archive_corruption_is_rejected_before_unpacking(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, _ = self.make_archive(root)
            archive.write_bytes(archive.read_bytes()+b'changed')
            with patch.object(auditor,'OUT',root), self.assertRaisesRegex(ValueError,'SHA256/size'):
                auditor.unpack_source_archive(archive,root/'unpacked')
            self.assertFalse((root/'unpacked').exists())


if __name__ == '__main__':
    unittest.main()
