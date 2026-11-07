#!/usr/bin/env python3
"""Relink unchanged local RF overview tiles to reviewed boundary provenance.

The overview pixels are masked by ``russia-canonical-area.geojson``. A change
that only repartitions the inverse outside-mask must not require rebuilding the
58 MB Natural Earth source raster, but the package still has to bind to the new
provenance record. This tool permits that metadata-only relink only when:

* the canonical area bytes are unchanged;
* the new provenance records the same canonical-area SHA-256;
* all 341 z0..4 PNG tiles still match their recorded size and SHA-256.

When any of those conditions fails, perform a full ``build-overview-relief.py``
rebuild instead of bypassing the integrity chain.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PACKAGE = ROOT / "web/public/maps/russia-relief"
DEFAULT_PROVENANCE = ROOT / "web/public/data/russia-boundaries-provenance.json"
DEFAULT_CANONICAL_AREA = ROOT / "web/public/data/russia-canonical-area.geojson"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def expected_tile_paths() -> set[str]:
    return {
        f"{zoom}/{x}/{y}.png"
        for zoom in range(5)
        for x in range(2**zoom)
        for y in range(2**zoom)
    }


def inspect_package(
    package: Path = DEFAULT_PACKAGE,
    provenance_path: Path = DEFAULT_PROVENANCE,
    canonical_area_path: Path = DEFAULT_CANONICAL_AREA,
) -> tuple[dict, str, str]:
    manifest_path = package / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    provenance_bytes = provenance_path.read_bytes()
    provenance = json.loads(provenance_bytes)

    if manifest.get("schemaVersion") != 1 or manifest.get("complete") is not True:
        raise RuntimeError("Overview manifest is incomplete")
    if (
        manifest.get("tileCount") != 341
        or manifest.get("minzoom") != 0
        or manifest.get("maxzoom") != 4
    ):
        raise RuntimeError("Overview tile matrix changed; perform a full overview rebuild")

    canonical_sha = sha256_file(canonical_area_path)
    manifest_mask = manifest.get("mask", {})
    provenance_asset = provenance.get("assets", {}).get(
        "russia-canonical-area.geojson", {}
    )
    if manifest_mask.get("path") != "/data/russia-canonical-area.geojson":
        raise RuntimeError("Overview references an unexpected mask path")
    if manifest_mask.get("sha256") != canonical_sha:
        raise RuntimeError("Canonical RF area differs from the overview mask; rebuild required")
    if provenance_asset.get("sha256") != canonical_sha:
        raise RuntimeError("Boundary provenance and canonical RF area differ")

    records = manifest.get("files")
    if not isinstance(records, list) or len(records) != 341:
        raise RuntimeError("Overview manifest must list exactly 341 raster tiles")

    actual_paths: set[str] = set()
    total_bytes = 0
    for record in records:
        relative = record.get("path")
        if (
            not isinstance(relative, str)
            or relative.startswith("/")
            or ".." in Path(relative).parts
        ):
            raise RuntimeError("Unsafe overview tile path")
        if relative in actual_paths:
            raise RuntimeError("Duplicate overview tile record: " + relative)
        actual_paths.add(relative)
        tile = package / relative
        if not tile.is_file():
            raise RuntimeError("Missing overview tile: " + relative)
        size = tile.stat().st_size
        if size != record.get("bytes"):
            raise RuntimeError("Overview tile size mismatch: " + relative)
        if sha256_file(tile) != record.get("sha256"):
            raise RuntimeError("Overview tile digest mismatch: " + relative)
        total_bytes += size

    if actual_paths != expected_tile_paths():
        raise RuntimeError("Overview does not contain the complete wrapped z0..4 XYZ matrix")
    if total_bytes != manifest.get("totalTileBytes"):
        raise RuntimeError("Overview total byte count differs from the manifest")

    return manifest, sha256_bytes(provenance_bytes), canonical_sha


def relink(
    package: Path = DEFAULT_PACKAGE,
    provenance_path: Path = DEFAULT_PROVENANCE,
    canonical_area_path: Path = DEFAULT_CANONICAL_AREA,
    *,
    check: bool = False,
) -> dict:
    manifest_path = package / "manifest.json"
    manifest, provenance_sha, canonical_sha = inspect_package(
        package, provenance_path, canonical_area_path
    )
    old_sha = manifest["mask"].get("provenanceSha256")
    changed = old_sha != provenance_sha
    if changed and check:
        raise RuntimeError(
            "Overview provenance link is stale: " + str(old_sha) + " != " + provenance_sha
        )
    if changed:
        manifest["mask"]["provenanceSha256"] = provenance_sha
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
        )

    report = {
        "changed": changed,
        "tileCountVerified": 341,
        "canonicalAreaSha256": canonical_sha,
        "provenanceSha256": provenance_sha,
        "manifestSha256": sha256_file(manifest_path),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, default=DEFAULT_PACKAGE)
    parser.add_argument("--provenance", type=Path, default=DEFAULT_PROVENANCE)
    parser.add_argument("--canonical-area", type=Path, default=DEFAULT_CANONICAL_AREA)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify the link without modifying the manifest",
    )
    args = parser.parse_args()
    relink(
        args.package,
        args.provenance,
        args.canonical_area,
        check=args.check,
    )


if __name__ == "__main__":
    main()
