"""Exercise the actual publication inventory with synthetic private files."""
import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("publish_inventory", Path(__file__).with_name("inventory.py"))
INVENTORY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INVENTORY)


class PublicationPrivacyTests(unittest.TestCase):
    def test_private_exports_queues_credentials_and_caches_never_reach_a_git_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "source"
            source.mkdir()
            allowed = {
                "web/lib/telegram-reviewed.generated.json": '{"schemaVersion":1,"routes":[],"sourcesByRouteId":{}}',
                "web/public/downloads/android-manifest.json": '{"version":"fixture"}',
                "tools/import-data/telegram/cli.py": 'print("public tool")\n',
                "docs/telegram-route-import.md": "Review instructions only.\n",
                "infra/.env.example": "APP_NAME=tropnik\n",
                ".github/workflows/pages.yml": "name: fixture\n",
            }
            blocked = [
                "tools/import-data/telegram/private/result.json",
                "private/review-decisions.json", "PRIVATE/nested/source.json",
                "exports/history.export.json", "exports/history.EXPORT.JSON",
                "exports/candidates.queue.json", "exports/candidates.QUEUE.JSON",
                ".cache/last-result.json", "__pycache__/importer.pyc",
                "web/node_modules/dependency/index.js", ".gradle/build.properties",
                "credentials/client.json", "secrets/mail-password.txt",
                ".ssh/config", ".aws/credentials", ".azure/token-cache.json",
                ".kube/config", ".gnupg/trustdb", ".npmrc", ".netrc", ".git-credentials",
                "infra/.env.production", "infra/local.properties", "keys/release.keystore",
            ]
            private_canary = "PRIVATE_SYNTHETIC_CONTENT_MUST_NOT_BE_UPLOADED"
            for path, content in allowed.items():
                target = source / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
            for path in blocked:
                target = source / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(private_canary)
            # Construct a fake token at runtime so this test source itself is
            # not correctly rejected by the inventory's credential scanner.
            secret = "ghp_" + "A" * 40
            (source / "innocent-settings.json").write_text(json.dumps({"access": secret}))
            (source / "outside-link.json").symlink_to(base / "outside.json")
            (base / "outside.json").write_text(private_canary)
            target = base / "inventory.json"
            args = argparse.Namespace(source=source, out=target, known_blobs=None,
                                      chunk_bytes=400_000, parent="0" * 40)
            with contextlib.redirect_stdout(io.StringIO()):
                INVENTORY.inventory(args)
            manifest = json.loads(target.read_text())
            self.assertEqual({entry["path"] for entry in manifest["entries"]}, set(allowed))
            excluded = {entry["path"] for entry in manifest["excluded"]}
            self.assertTrue(set(blocked) <= excluded)
            self.assertIn("innocent-settings.json", excluded)
            # rg may omit a symlink before the inventory loop sees it. A
            # forged later payload entry must still fail the checked reader.
            with self.assertRaisesRegex(ValueError, "escaped"):
                INVENTORY.read_checked(source, {"path": "outside-link.json", "bytes": len(private_canary),
                                                "gitBlobSha": INVENTORY.blob_sha(private_canary.encode())})
            for chunk in manifest["textTreeChunks"]:
                payload = base / f"chunk-{chunk['index']}.json"
                extract = argparse.Namespace(inventory=target, source=source, kind="text-tree", chunk=chunk["index"],
                                             sha=None, base_tree=None, stdout=False, out=payload)
                with contextlib.redirect_stdout(io.StringIO()):
                    INVENTORY.extract(extract)
                text = payload.read_text()
                self.assertNotIn(private_canary, text)
                self.assertNotIn(secret, text)
            self.assertEqual(manifest["summary"]["publish"]["files"], len(allowed))

    def test_only_compound_export_suffixes_are_excluded(self):
        # Reviewed data and legitimate source names must remain publishable.
        for path in ["web/lib/telegram-reviewed.generated.json", "docs/queue-design.md",
                     "tools/import-data/telegram/importer.py", "examples/export-format.json"]:
            with self.subTest(path=path):
                self.assertIsNone(INVENTORY.exclusion(Path(path)))


if __name__ == "__main__":
    unittest.main()
