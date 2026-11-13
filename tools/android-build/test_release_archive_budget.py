"""Source archive budgets; filesystem fixtures, no SDK, device or network claims."""
from __future__ import annotations

import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import preview_artifacts as artifacts
import test_release_pipeline as pipeline

release = pipeline.release
VERSION = "0.4.16-preview"
SOURCE_NAME = f"tropnik-{VERSION}-source.tar.gz"


def sparse_file(path, size):
    with path.open("wb") as stream:
        stream.truncate(size)
    return path


def zero_sha256(size):
    digest = hashlib.sha256()
    block = bytes(1024 * 1024)
    while size:
        part = block[:min(size, len(block))]
        digest.update(part)
        size -= len(part)
    return digest.hexdigest()


class FingerprintBudgetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)

    def reject_size_without_read(self, action, path, size, limit):
        with patch.object(Path, "open", side_effect=AssertionError("Rejected artifact was opened")):
            with self.assertRaises(ValueError) as caught:
                action(path)
        self.assertIn(path.name, str(caught.exception))
        self.assertIn(f"bytes={size}, limit={limit}", str(caught.exception))

    def test_fingerprint_hashes_complete_nonempty_bytes(self):
        payload = bytes(range(256)) * 4097 + b"last bytes"
        path = self.base / "payload.apk"
        path.write_bytes(payload)
        self.assertEqual(artifacts.fingerprint(path),
                         {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})

    def test_default_cap_accepts_boundary_and_rejects_next_byte(self):
        path = sparse_file(self.base / "payload.apk", 150_000_000)
        self.assertEqual(artifacts.fingerprint(path),
                         {"bytes": 150_000_000, "sha256": zero_sha256(150_000_000)})
        sparse_file(path, 150_000_001)
        self.reject_size_without_read(artifacts.fingerprint, path, 150_000_001, 150_000_000)

    def test_only_exact_source_name_gets_the_source_budget(self):
        path = sparse_file(self.base / SOURCE_NAME, 150_000_001)
        self.assertEqual(release.release_asset_fingerprint(path, VERSION)["bytes"], 150_000_001)
        self.reject_size_without_read(artifacts.fingerprint, path, 150_000_001, 150_000_000)
        for name in (artifacts.UNIVERSAL, artifacts.ARM64, artifacts.RECEIPT,
                     "verification-reports.zip", "checksums.sha256", "release-body.md",
                     "tropnik-0.4.17-preview-source.tar.gz", SOURCE_NAME + ".apk"):
            with self.subTest(name=name):
                path = path.rename(self.base / name)
                self.reject_size_without_read(
                    lambda value: release.release_asset_fingerprint(value, VERSION),
                    path, 150_000_001, 150_000_000)

    def test_source_cap_accepts_boundary_and_rejects_next_byte(self):
        path = sparse_file(self.base / SOURCE_NAME, 200_000_000)
        self.assertEqual(release.release_asset_fingerprint(path, VERSION),
                         {"bytes": 200_000_000, "sha256": zero_sha256(200_000_000)})
        sparse_file(path, 200_000_001)
        self.reject_size_without_read(
            lambda value: release.release_asset_fingerprint(value, VERSION),
            path, 200_000_001, 200_000_000)

    def test_empty_missing_directory_and_links_fail_for_both_budgets(self):
        target = self.base / "nonempty-target"
        target.write_bytes(b"real bytes")
        actions = (
            ("payload.apk", artifacts.fingerprint, 150_000_000),
            (SOURCE_NAME, lambda value: release.release_asset_fingerprint(value, VERSION), 200_000_000),
        )
        for name, action, limit in actions:
            for kind in ("empty", "missing", "directory", "symlink", "dangling-symlink"):
                with self.subTest(name=name, kind=kind):
                    directory = self.base / (name + "-" + kind)
                    directory.mkdir()
                    path = directory / name
                    if kind == "empty":
                        path.touch()
                        self.reject_size_without_read(action, path, 0, limit)
                        continue
                    if kind == "directory":
                        path.mkdir()
                    elif kind.endswith("symlink"):
                        path.symlink_to(target if kind == "symlink" else self.base / "absent-target")
                    with patch.object(Path, "open", side_effect=AssertionError("Invalid artifact was opened")):
                        with self.assertRaises(ValueError):
                            action(path)

    def test_invalid_explicit_budgets_are_rejected_before_read(self):
        path = self.base / "payload.apk"
        path.write_bytes(b"bytes")
        for value in (None, True, False, 0, -1, 1.5, float("inf")):
            with self.subTest(value=value):
                with patch.object(Path, "open", side_effect=AssertionError("Invalid budget read a file")):
                    with self.assertRaisesRegex(ValueError, "positive integer"):
                        artifacts.fingerprint(path, max_bytes=value)


class SourceArchivePipelineTests(unittest.TestCase):
    def setUp(self):
        self.fixture = pipeline.ReleaseFixture("test_prepared_release_is_reproducible_and_arm64_not_device_claimed")
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.setUp()

    def archive_output(self, size):
        # Isolate archive sizing, while checking the unchanged full-commit command.
        # These sparse bytes are not claimed to be a real archive or APK.
        actual_run = subprocess.run
        self.archive_calls = []

        def run(command, **kwargs):
            if command[:2] != ["git", "archive"]:
                return actual_run(command, **kwargs)
            self.assertEqual(command, ["git", "archive", "--format=tar.gz",
                                      f"--prefix=tropnik-{VERSION}/", self.fixture.commit])
            self.assertEqual(kwargs["cwd"], self.fixture.root)
            self.assertIs(kwargs["check"], True)
            self.assertEqual(Path(kwargs["stdout"].name).name, SOURCE_NAME)
            kwargs["stdout"].truncate(size)
            self.archive_calls.append(command)
            return subprocess.CompletedProcess(command, 0)

        return patch.object(subprocess, "run", side_effect=run)

    def prepare(self, name):
        fixture = self.fixture
        output = fixture.base / name
        return output, release.prepare(fixture.root, fixture.dist, fixture.device, output)

    def test_prepare_public_rebuild_and_publish_recheck_large_source(self):
        fixture = self.fixture
        public = pipeline.module("archive_budget_public_verifier", "verify-public-preview.py")
        with self.archive_output(150_000_001):
            output, publication = self.prepare("candidate")
            rebuilt = public.release.prepare(fixture.root, fixture.dist, fixture.device, fixture.base / "rebuilt")
        self.assertEqual(len(self.archive_calls), 2)
        self.assertEqual(publication, rebuilt)
        self.assertEqual(len(publication["assets"]), 6)
        source = next(item for item in publication["assets"] if item["name"] == SOURCE_NAME)
        self.assertEqual(source["bytes"], 150_000_001)
        checksums = {name: sha for sha, name in
                     (line.split("  ", 1) for line in (output / "checksums.sha256").read_text().splitlines())}
        self.assertEqual(checksums[SOURCE_NAME], source["sha256"])
        body = (output / "release-body.md").read_text()

        class ExistingRelease:
            def __init__(self):
                self.calls = []

            def request(self, method, path, **kwargs):
                self.calls.append((method, path))
                if method != "GET":
                    raise AssertionError("Already published bytes must not be written")
                if "/git/ref/" in path:
                    return {"object": {"sha": publication["sourceCommit"]}}
                if "/releases/tags/" in path:
                    return {"draft": False, "prerelease": True, "body": body,
                            "html_url": "https://github.com/orewn/tropnik/releases/tag/" + publication["tag"],
                            "assets": [{"name": item["name"], "state": "uploaded", "size": item["bytes"],
                                        "digest": "sha256:" + item["sha256"]} for item in publication["assets"]]}
                raise AssertionError("Unexpected release request")

        client = ExistingRelease()
        self.assertEqual(release.publish(output, client)["status"], "already-published-identical")
        self.assertEqual(len(client.calls), 2)
        with (output / SOURCE_NAME).open("r+b") as stream:
            stream.seek(150_000_000)
            stream.write(b"x")
        client.calls.clear()
        with self.assertRaisesRegex(ValueError, "Prepared release asset changed"):
            release.publish(output, client)
        self.assertEqual(client.calls, [])

    def test_source_above_its_budget_stops_preparation(self):
        with self.archive_output(200_000_001):
            with self.assertRaisesRegex(ValueError, "bytes=200000001, limit=200000000"):
                self.prepare("oversized")
        self.assertEqual(len(self.archive_calls), 1)
        self.assertFalse((self.fixture.base / "oversized/release-upload.json").exists())

    def test_publish_rechecks_source_limit_and_uses_validated_tag(self):
        for forged_version in (False, True):
            with self.subTest(forged_version=forged_version):
                output, publication = self.prepare("publish-" + str(forged_version))
                source = next(item for item in publication["assets"] if item["name"] == SOURCE_NAME)
                path = output / SOURCE_NAME
                if forged_version:
                    publication["version"] = "0.4.17-preview"
                    source["name"] = "tropnik-0.4.17-preview-source.tar.gz"
                    path = path.rename(output / source["name"])
                limit = 150_000_000 if forged_version else 200_000_000
                sparse_file(path, limit + 1)
                source.update(bytes=limit + 1, sha256="0" * 64)
                self.fixture.json(output / "release-upload.json", publication)

                class NoAPI:
                    def __init__(self):
                        self.calls = []

                    def request(self, *args, **kwargs):
                        self.calls.append(args)
                        raise AssertionError("Invalid local artifact reached the API")

                client = NoAPI()
                with self.assertRaisesRegex(ValueError, f"bytes={limit + 1}, limit={limit}"):
                    release.publish(output, client)
                self.assertEqual(client.calls, [])


if __name__ == "__main__":
    unittest.main()
