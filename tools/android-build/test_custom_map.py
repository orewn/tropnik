from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest
from asset_integrity import AssetError
from custom_map import digest, json_bytes, verify_custom_map

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "android/app/src/main/assets"


class CustomMapIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bytes = (ASSETS / "custom-map/manifest.json").read_bytes()
        cls.manifest = json.loads(cls.bytes)
        cls.files = ["custom-map/" + record["path"] for record in cls.manifest["files"]] + ["custom-map/manifest.json"]

    def read(self, path):
        return (ASSETS / path).read_bytes()

    def test_packaged_shared_runtime_and_every_local_source_are_hash_verified(self):
        report = verify_custom_map(self.bytes, self.read, actual_files=self.files, source_root=ROOT)
        self.assertEqual(report["mapRenderer"], "tropnik-canvas")
        self.assertEqual(report["mapRendererOfflineVectorTiles"], 193)
        self.assertEqual(report["mapRendererOfflineDemTiles"], 21)
        self.assertFalse(report["mapRendererNativeSdkRequired"])

    def test_corrupt_worker_missing_file_and_extra_runtime_fail_closed(self):
        worker = "custom-map/" + next(record["path"] for record in self.manifest["files"] if record["path"].startswith("workers/custom-map-tiles.worker-"))
        with self.assertRaisesRegex(AssetError, "Packaged map runtime differs"):
            verify_custom_map(self.bytes, lambda name: self.read(name) + (b"tamper" if name == worker else b""))
        with self.assertRaisesRegex(AssetError, "Unlisted or missing"):
            verify_custom_map(self.bytes, self.read, actual_files=self.files + ["custom-map/injected.js"])

    def test_input_digest_and_alias_traversal_cannot_be_rewritten(self):
        forged = copy.deepcopy(self.manifest)
        forged["sourceInputs"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(AssetError, "input-set digest"):
            verify_custom_map(json_bytes(forged), self.read)
        # Even a rewritten aggregate digest cannot admit an SDK module into
        # the shared renderer's reviewed transitive source graph.
        forged = copy.deepcopy(self.manifest)
        vendor = copy.deepcopy(forged["sourceInputs"][0]); vendor["path"] = "web/lib/maplibre-gl/runtime.ts"
        forged["sourceInputs"].append(vendor)
        forged["sourceInputsSha256"] = digest(json_bytes(forged["sourceInputs"]))
        with self.assertRaisesRegex(AssetError, "vendor renderer source"):
            verify_custom_map(json_bytes(forged), self.read)
        forged = copy.deepcopy(self.manifest)
        forged["resourceAliases"][0]["url"] = "/../private"
        with self.assertRaises((AssetError, ValueError)):
            verify_custom_map(json_bytes(forged), self.read)


if __name__ == "__main__":
    unittest.main()
