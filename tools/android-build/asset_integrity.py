"""Shared, dependency-free integrity checks for the bundled terrain and viewer.

The checks run against both source directories and the actual APK ZIP. They use
explicit failures (not Python assertions) so `python -O` cannot disable a gate.
"""
from __future__ import annotations

import hashlib
import base64
import html
import json
import math
import re
import struct
from pathlib import PurePosixPath
from typing import Callable, Iterable


class AssetError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssetError(message)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_relative(value: object) -> str:
    require(isinstance(value, str) and bool(value), "Missing asset path")
    require("\\" not in value and ":" not in value and "\x00" not in value,
            "Invalid asset path")
    path = PurePosixPath(value)
    require(not path.is_absolute() and all(part not in {"", ".", ".."} for part in value.split("/")),
            "Asset path escapes its package")
    return value


def verify_files(manifest: dict, read: Callable[[str], bytes], *,
                 actual_files: Iterable[str] | None = None) -> tuple[int, int]:
    require(manifest.get("schemaVersion") == 1 and manifest.get("complete") is True,
            "Package manifest is not complete")
    records = manifest.get("files")
    require(isinstance(records, list) and 1 <= len(records) <= 512,
            "Invalid package file count")
    seen: set[str] = set()
    size = 0
    for record in records:
        relative = safe_relative(record.get("path"))
        require(relative != "manifest.json" and relative not in seen, "Duplicate or recursive manifest entry")
        seen.add(relative)
        expected_size = record.get("sizeBytes", record.get("size", record.get("bytes")))
        require(isinstance(expected_size, int) and not isinstance(expected_size, bool)
                and 0 < expected_size <= 16 * 1024 * 1024, "Invalid asset size")
        expected_digest = record.get("sha256")
        require(isinstance(expected_digest, str) and re.fullmatch(r"[a-f0-9]{64}", expected_digest) is not None,
                "Invalid asset digest")
        try:
            data = read(relative)
        except (FileNotFoundError, KeyError) as error:
            raise AssetError("Missing packaged asset: " + relative) from error
        require(len(data) == expected_size, "Asset length mismatch: " + relative)
        require(digest(data) == expected_digest, "Asset digest mismatch: " + relative)
        size += len(data)
    if actual_files is not None:
        require(set(actual_files) == seen | {"manifest.json"}, "Unlisted or missing package files")
    return len(records), size


def verify_terrain(manifest_bytes: bytes, read: Callable[[str], bytes], *,
                   actual_files: Iterable[str] | None = None) -> dict:
    manifest = json.loads(manifest_bytes)
    count, size = verify_files(manifest, read, actual_files=actual_files)
    require(manifest.get("encoding") == "terrarium" and manifest.get("tileSize") == 256
            and manifest.get("scheme") == "xyz", "Unexpected DEM encoding")
    bounds = manifest.get("bounds")
    require(isinstance(bounds, list) and len(bounds) == 4
            and all(isinstance(v, (int, float)) and math.isfinite(v) for v in bounds), "Invalid DEM bounds")
    west, south, east, north = bounds
    require(-180 <= west < east <= 180 and -85 < south < north < 85, "Invalid DEM area")
    minimum, maximum = manifest.get("minzoom"), manifest.get("maxzoom")
    require(isinstance(minimum, int) and isinstance(maximum, int)
            and 0 <= minimum <= maximum <= 16, "Invalid DEM zoom range")

    def tile_y(latitude: float, zoom: int) -> int:
        return math.floor((1 - math.asinh(math.tan(math.radians(latitude))) / math.pi) / 2 * (2 ** zoom))

    expected = set()
    for zoom in range(minimum, maximum + 1):
        first_x = math.floor((west + 180) / 360 * (2 ** zoom))
        last_x = math.floor((east + 180) / 360 * (2 ** zoom))
        for x in range(first_x, last_x + 1):
            for y in range(tile_y(north, zoom), tile_y(south, zoom) + 1):
                expected.add(f"tiles/{zoom}/{x}/{y}.png")
    present = {entry["path"] for entry in manifest["files"] if entry["path"].startswith("tiles/")}
    require(present == expected and manifest.get("tileCount") == len(expected), "DEM does not cover its stated bounds")
    for relative in sorted(present):
        data = read(relative)
        require(data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR"
                and struct.unpack(">II", data[16:24]) == (256, 256), "Invalid DEM PNG tile")
    grid = json.loads(read(safe_relative(manifest.get("gridPath"))))
    width, height, elevations = grid.get("width"), grid.get("height"), grid.get("elevations")
    require(isinstance(width, int) and isinstance(height, int) and 2 <= width <= 1025 and 2 <= height <= 1025,
            "Invalid terrain grid dimensions")
    require(isinstance(elevations, list) and len(elevations) == width * height
            and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in elevations),
            "Incomplete or non-finite terrain grid")
    require(grid.get("bounds") == bounds, "Terrain grid and tiles cover different areas")
    require(grid.get("minElevation") == min(elevations) and grid.get("maxElevation") == max(elevations),
            "Grid height range does not match its values")
    require(manifest.get("source", {}).get("licensePath") in {entry["path"] for entry in manifest["files"]}
            and "ATTRIBUTION.txt" in {entry["path"] for entry in manifest["files"]}, "Terrain licence missing")
    return {"terrainTileCount": len(present), "terrainManifestFilesVerified": count,
            "terrainManifestBytesVerified": size, "terrainGridSamples": len(elevations),
            "terrainBounds": bounds, "terrainManifestSha256": digest(manifest_bytes)}


def verify_landscape(manifest_bytes: bytes, read: Callable[[str], bytes], terrain_manifest: bytes) -> dict:
    manifest = json.loads(manifest_bytes)
    count, size = verify_files(manifest, read)
    require(count == 1 and manifest["files"][0]["path"] == "landscape.html", "Unexpected landscape entrypoint")
    require(size <= 2 * 1024 * 1024, "Landscape exceeds its Android byte budget")
    require(manifest.get("terrainManifestSha256") == digest(terrain_manifest), "Landscape uses another terrain package")
    require(manifest.get("offline") is True, "Landscape is not self-contained")
    document = read("landscape.html").decode("utf-8")
    policy_match = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)"', document)
    policy = html.unescape(policy_match.group(1)) if policy_match else ""
    require("default-src 'none'" in policy and "connect-src 'none'" in policy
            and "base-uri 'none'" in policy and "object-src 'none'" in policy,
            "Landscape network policy is missing")
    require("'unsafe-inline'" not in policy and "'unsafe-eval'" not in policy,
            "Landscape policy permits untrusted code")
    for tag in ("script", "style"):
        blocks = re.findall(r"<" + tag + r"(?:\s[^>]*)?>(.*?)</" + tag + ">", document, re.S)
        require(bool(blocks), "Missing landscape " + tag)
        for block in blocks:
            expected_hash = "'sha256-" + base64.b64encode(hashlib.sha256(block.encode("utf-8")).digest()).decode("ascii") + "'"
            require(expected_hash in policy, "Landscape content does not match its CSP hash")
    require(re.search(r"<(?:script|link|iframe|img)\b[^>]*(?:src|href)\s*=", document, re.I) is None,
            "Landscape has an external resource")
    require("new TerrainRenderer(" in document and 'id="terrain-canvas"' in document,
            "Landscape renderer is missing")
    # Check the grid actually embedded in the document. Manifest linkage alone
    # would allow an old, coarse HTML scene beside a new provenance record.
    grids = re.findall(r"^const terrainGrid=(\{[^\r\n]+\});$", document, re.M)
    require(len(grids) == 1 and digest(grids[0].encode("utf-8")) == manifest.get("embeddedGridSha256"),
            "Embedded landscape grid differs from its manifest")
    grid = json.loads(grids[0])
    width, height, heights = grid.get("width"), grid.get("height"), grid.get("elevations")
    require(isinstance(width, int) and isinstance(height, int) and 2 <= width <= 1025 and 2 <= height <= 1025
            and manifest.get("gridDimensions") == [width, height], "Landscape grid dimensions differ")
    require(isinstance(heights, list) and len(heights) == width * height
            and all(isinstance(v, (float, int)) and not isinstance(v, bool) and math.isfinite(v)
                    and -12000 <= v <= 10000 for v in heights), "Invalid embedded landscape heights")
    parent_sha = digest(terrain_manifest)
    provenance = manifest.get("gridProvenance", {})
    require(provenance.get("inputManifest", {}).get("sha256") == parent_sha
            and grid.get("processing", {}).get("inputManifestSha256") == parent_sha
            and grid.get("source", {}).get("archiveManifestSha256") == parent_sha,
            "Landscape derivative belongs to another terrain archive")
    require(provenance.get("output", {}).get("sha256") == manifest.get("gridSha256")
            and provenance.get("output", {}).get("dimensions") == [width, height],
            "Landscape derivative proof does not match the scene")
    require(grid.get("bounds") == json.loads(terrain_manifest).get("bounds")
            and grid.get("units") == "meters" and grid.get("rowOrder") == "north-to-south"
            and grid.get("columnOrder") == "west-to-east", "Landscape spatial metadata differs")
    return {"landscapeManifestFilesVerified": count, "landscapeBytesVerified": size,
            "landscapeSha256": digest(read("landscape.html")), "landscapeOffline": True,
            "landscapeGridDimensions": [width, height], "landscapeGridSamples": len(heights),
            "landscapeGridSourceSha256": manifest["gridSha256"],
            "landscapeGridEmbeddedSha256": manifest["embeddedGridSha256"],
            "landscapeGridSpacingApproxM": grid.get("sampleSpacingApproxM")}
