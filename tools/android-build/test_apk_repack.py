import tempfile
import unittest
from pathlib import Path
import zipfile
from apk_repack import entry_digests, repack_lossless


class ApkRepackTests(unittest.TestCase):
    def test_geometry_dex_and_stored_resources_keep_exact_payload(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, target = Path(temporary) / "source.apk", Path(temporary) / "target.apk"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("classes.dex", bytes(range(256)) * 4000, compress_type=zipfile.ZIP_DEFLATED, compresslevel=1)
                archive.writestr("assets/routes.geojson", b'{"coordinates":[[40.3972901,43.7417408],[40.4380182,43.7632088]]}', compress_type=zipfile.ZIP_DEFLATED)
                archive.writestr("resources.arsc", bytes(range(256)), compress_type=zipfile.ZIP_STORED)
            before = source.read_bytes()
            report = repack_lossless(source, target)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(entry_digests(source), entry_digests(target))
            self.assertTrue(report["allUncompressedEntrySha256Unchanged"])
            self.assertLess(target.stat().st_size, source.stat().st_size)
            with zipfile.ZipFile(target) as archive:
                self.assertEqual(archive.getinfo("resources.arsc").compress_type, zipfile.ZIP_STORED)

    def test_duplicate_entries_and_source_overwrite_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, target = Path(temporary) / "source.apk", Path(temporary) / "target.apk"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("classes.dex", b"first")
                with self.assertWarns(UserWarning):
                    archive.writestr("classes.dex", b"second")
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                repack_lossless(source, target)
            with self.assertRaisesRegex(ValueError, "preserve"):
                repack_lossless(source, source)


if __name__ == "__main__":
    unittest.main()
