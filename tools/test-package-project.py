"""Export-boundary tests: source completeness without credentials or build output."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import tempfile
import unittest

spec = spec_from_file_location("package_project", Path(__file__).with_name("package-project.py"))
package = module_from_spec(spec)
spec.loader.exec_module(package)


class SourceExportTest(unittest.TestCase):
    def put(self, root, rel, data=b"example"):
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return p

    def test_build_and_credential_paths_are_excluded_but_runtime_tiles_survive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wanted = ["web/public/offline-map/localtiles/12/2507/1493.pbf", "android/app/src/main/assets/licenses/notice.txt", "infra/.env.example", "android/gradle/wrapper/gradle-wrapper.jar"]
            blocked = ["web/node_modules/module/a.js", "android/app/build/result.apk", "web/public/downloads/app.apk", "android/local.properties", "infra/.env", "android/app/src/release/signing.keystore", "tools/import-data/_deps/library.py"]
            for rel in wanted + blocked:
                self.put(root, rel)
            selected, _ = package.select_files(root, "source", require_project=False)
            self.assertEqual(set(wanted), {p.relative_to(root).as_posix() for p in selected})

    def test_github_omits_audit_bulk_without_dropping_runtime_pbf(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bulk = ["data/catalog/raw-trails-krym.geojson", "data/catalog/raw/geofabrik/sample.osm.pbf"]
            runtime = "data/pilot-map/localtiles/10/626/373.pbf"
            for rel in bulk + [runtime]:
                self.put(root, rel)
            source, _ = package.select_files(root, "source", require_project=False)
            github, _ = package.select_files(root, "github", require_project=False)
            self.assertEqual(3, len(source))
            self.assertEqual([runtime], [p.relative_to(root).as_posix() for p in github])

    def test_android_page_manifest_survives_but_download_binaries_do_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = "web/public/downloads/android-manifest.json"
            page = "web/app/android/page.tsx"
            self.put(root, manifest, b'{"version":"0.4.0-merged-preview"}')
            self.put(root, page, b"import androidBuild from '@/public/downloads/android-manifest.json';")
            for blocked in ("web/public/downloads/tropnik-arm64-preview.apk",
                            "web/public/downloads/other.json",
                            "web/public/downloads/nested/android-manifest.json"):
                self.put(root, blocked)
            for profile in ("source", "github"):
                selected, _ = package.select_files(root, profile, require_project=False)
                self.assertEqual({manifest, page}, {p.relative_to(root).as_posix() for p in selected})

    def test_boundary_raw_sources_and_renderer_docs_survive_without_processing_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wanted = [
                "data/boundaries/raw/geoBoundaries-RUS-ADM1.geojson",
                "data/boundaries/raw/geoBoundaries-UKR-ADM1.geojson",
                "data/boundaries/manifest.json",
                "data/boundaries/ATTRIBUTION.txt",
                "web/docs/vinext-runtime.md",
                "web/public/terrain/terrain-renderer.js",
            ]
            blocked = [
                "data/boundaries/selected-area-source.wkb",
                "data/boundaries/selected-area-source-cache.json",
                "data/boundaries/cache/transient.json",
            ]
            for rel in wanted + blocked:
                self.put(root, rel)
            for profile in ("source", "github"):
                selected, _ = package.select_files(root, profile, require_project=False)
                self.assertEqual(set(wanted), {p.relative_to(root).as_posix() for p in selected})

    def test_selected_symlink_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outside = self.put(root, "outside.txt")
            (root / "web/public").mkdir(parents=True)
            (root / "web/public/link.txt").symlink_to(outside)
            with self.assertRaises(package.PackagingError):
                package.select_files(root, "source", require_project=False)

    def test_sensitive_content_reports_only_path_and_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake = b"ghp_" + b"A" * 40
            file = self.put(root, "backend/example.txt", fake)
            with self.assertRaises(package.PackagingError) as result:
                package.scan_and_record(root, [file])
            self.assertIn("backend/example.txt: github_token", str(result.exception))
            self.assertNotIn(fake.decode(), str(result.exception))

    def test_snapshot_roundtrip_and_existing_output_protection(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "input"
            file = self.put(root, "backend/README.md", "Тропник\n".encode())
            records = package.scan_and_record(root, [file])
            result = package.make_snapshot(root, base / "delivery", records, "source", {})
            self.assertTrue(result["zipVerified"])
            self.assertEqual(file.read_bytes(), (Path(result["staging"]) / "backend/README.md").read_bytes())
            with self.assertRaises(package.PackagingError):
                package.make_snapshot(root, base / "delivery", records, "source", {})
            with self.assertRaises(package.PackagingError):
                package.make_snapshot(root, root / "delivery", records, "source", {})

    def test_changed_source_aborts_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "input"
            file = self.put(root, "backend/README.md", b"before")
            records = package.scan_and_record(root, [file])
            file.write_bytes(b"after")
            with self.assertRaises(package.PackagingError):
                package.make_snapshot(root, base / "delivery", records, "source", {})


if __name__ == "__main__":
    unittest.main()
