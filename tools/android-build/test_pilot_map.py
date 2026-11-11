from pathlib import Path
import json
import unittest
from asset_integrity import AssetError
from pilot_map import package_from_source, verify_pilot

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'data/pilot-map'


class PilotMapDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (SOURCE / 'manifest.json').read_bytes()
        cls.files = package_from_source(cls.source, lambda path: (SOURCE / path).read_bytes())

    def test_every_vector_and_provenance_byte_survives_without_vendor_font_runtime(self):
        report = verify_pilot(self.files['manifest.json'], self.files.__getitem__, actual_files=self.files)
        self.assertEqual(report['offlineTileCount'], 193)
        self.assertFalse(report['offlineMapVendorGlyphsPackaged'])
        self.assertEqual(self.files['source-manifest.json'], self.source)
        self.assertFalse(any(path.startswith('fonts/') for path in self.files))
        for record in json.loads(self.source)['files']:
            if not record['path'].startswith('fonts/'):
                self.assertEqual(self.files[record['path']], (SOURCE / record['path']).read_bytes())

    def test_corrupted_missing_or_extra_files_cannot_form_a_verified_package(self):
        tile = next(path for path in self.files if path.startswith('localtiles/'))
        with self.assertRaisesRegex(AssetError, 'changed'):
            verify_pilot(self.files['manifest.json'], lambda path: self.files[path] + (b'corrupt' if path == tile else b''))
        with self.assertRaisesRegex(AssetError, 'Unlisted or missing'):
            verify_pilot(self.files['manifest.json'], self.files.__getitem__, actual_files=[path for path in self.files if path != tile])
        with self.assertRaisesRegex(AssetError, 'Unlisted or missing'):
            verify_pilot(self.files['manifest.json'], self.files.__getitem__, actual_files=[*self.files, 'fonts/Noto/0-255.pbf'])


if __name__ == '__main__':
    unittest.main()
