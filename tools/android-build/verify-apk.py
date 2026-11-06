#!/usr/bin/env python3
"""Verify native APK assets without claiming a device navigation test.

Checks bundled offline bytes, full catalogue, font coverage and the explicit
online source allowlist. Android signature/ZIP alignment are checked separately
with the SDK apksigner and zipalign tools by build.sh.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
from pathlib import Path
import zipfile
from asset_integrity import require, safe_relative, verify_landscape, verify_terrain
from display_scope import PROVENANCE_FILE, verify_display_scope
from russia_relief import OVERVIEW_SOURCES_HEADING, verify_overview
from catalog_integrity import verify_catalog, verify_map_resources


def verify_apk(apk: Path) -> dict:
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "Duplicate APK entry")
        require(archive.testzip() is None, "APK CRC failure")
        prefix = "assets/maps/pilot/"
        manifest = json.loads(archive.read(prefix + "manifest.json"))
        # The source manifest is preserved verbatim in the APK.
        require(manifest.get("complete") is True, "Offline map manifest is incomplete")
        records = manifest.get("files", manifest.get("assets", []))
        if isinstance(records, dict):
            records = [{"path": key, **value} for key, value in records.items()]
        verified_bytes = 0
        for record in records:
            relative = safe_relative(record.get("path"))
            data = archive.read(prefix + relative)
            expected_size = record.get("size", record.get("bytes"))
            require(len(data) == expected_size, f"Asset length mismatch: {relative}")
            require(hashlib.sha256(data).hexdigest() == record["sha256"], f"Asset digest mismatch: {relative}")
            verified_bytes += len(data)
        tiles = [name for name in names if name.startswith(prefix + "localtiles/") and name.endswith(".pbf")]
        require(len(tiles) == 193, "Offline vector tile count differs")
        for block in ("0-255", "1024-1279", "8192-8447", "9472-9727"):
            require(prefix + f"fonts/Noto Sans Regular/{block}.pbf" in names, "Offline font glyph block is missing")
        style = json.loads(archive.read("assets/maps/style.json"))
        map_resources_report = verify_map_resources(style)
        online_manifest_bytes = archive.read("assets/maps/online-sources.json")
        online_manifest = json.loads(online_manifest_bytes)
        require(style.get("metadata", {}).get("tropnik:onlineSourcesManifestSha256") == hashlib.sha256(online_manifest_bytes).hexdigest()
                and online_manifest.get("sources") == {key: value for key, value in style["sources"].items() if key.startswith("online-")}
                and online_manifest.get("layerIds") == [layer["id"] for layer in style["layers"] if layer["id"].startswith("online-")]
                and online_manifest.get("fullRussiaDetailedOffline") is False,
                "Native online source provenance or scope differs")
        map_resources_report["onlineSourcesManifestSha256"] = hashlib.sha256(online_manifest_bytes).hexdigest()
        scope_prefix = "assets/maps/russia/"
        scope_report = verify_display_scope(archive.read(scope_prefix + PROVENANCE_FILE),
            lambda path: archive.read(scope_prefix + path), style)
        overview_prefix = "assets/maps/russia-relief/"
        overview_report = verify_overview(archive.read(overview_prefix + "manifest.json"),
            lambda path: archive.read(overview_prefix + path), style=style,
            actual_files=[name[len(overview_prefix):] for name in names if name.startswith(overview_prefix) and not name.endswith("/")],
            provenance_bytes=archive.read(scope_prefix + PROVENANCE_FILE))
        require(OVERVIEW_SOURCES_HEADING in archive.read("assets/SOURCES.txt").decode("utf-8"),
                "Overview attribution is not reachable in the native sources dialog")
        terrain_prefix = "assets/maps/terrain-pilot/"
        terrain_manifest = archive.read(terrain_prefix + "manifest.json")
        terrain_report = verify_terrain(terrain_manifest,
            lambda path: archive.read(terrain_prefix + path),
            actual_files=[name[len(terrain_prefix):] for name in names if name.startswith(terrain_prefix) and not name.endswith("/")])
        source = style["sources"].get("pilot-dem", {})
        require(source.get("type") == "raster-dem" and source.get("encoding") == "terrarium"
                and source.get("tileSize") == 256 and source.get("bounds") == terrain_report["terrainBounds"]
                and source.get("tiles") == ["asset://maps/terrain-pilot/tiles/{z}/{x}/{y}.png"],
                "Native map does not use the bundled DEM")
        shading = [layer for layer in style["layers"] if layer.get("id") == "pilot-hillshade"]
        require(len(shading) == 1 and shading[0].get("type") == "hillshade" and shading[0].get("source") == "pilot-dem"
                and shading[0].get("paint", {}).get("hillshade-illumination-anchor") == "viewport",
                "Native camera-relative hillshade is missing")
        require(style.get("metadata", {}).get("tropnik:terrainManifestSha256") == terrain_report["terrainManifestSha256"],
                "Native style and terrain package differ")
        landscape_prefix = "assets/landscape/"
        landscape_manifest = archive.read(landscape_prefix + "manifest.json")
        landscape_report = verify_landscape(landscape_manifest,
            lambda path: archive.read(landscape_prefix + path), terrain_manifest)
        require("assets/licenses/Manrope-OFL.txt" in names and "assets/licenses/Manrope-Scene-OFL.txt" in names,
                "Native or scene font licence missing")
        require("res/font/manrope.ttf" in names, "Native Manrope font missing")
        catalog = json.loads(archive.read("assets/catalog.json"))
        catalog_report = verify_catalog(archive.read("assets/catalog-manifest.json"),
            lambda path: archive.read("assets/" + path),
            actual_geometry=[name[len("assets/"):] for name in names if name.startswith("assets/maps/routes/") and not name.endswith("/")])
        advisory = next(route for route in catalog["routes"] if route["id"] == "kavkaz-8a")
        require("закрыт" in advisory["currentAdvisory"].lower(), "Current closure advisory missing")
        require(len([r for r in catalog["routes"] if r.get("illustrative")]) == 1, "Illustrative route count differs")
        require(not set(scope_report["russiaExcludedCatalogRouteIds"]).intersection(route["id"] for route in catalog["routes"]),
                "An excluded outside-scope route is present in the native catalog")
        abis = sorted({name.split("/")[1] for name in names if name.startswith("lib/") and name.endswith(".so")})
        native_alignment = {}
        for name in names:
            if name.startswith(("lib/arm64-v8a/", "lib/x86_64/")) and name.endswith(".so"):
                data = archive.read(name)
                require(data[:4] == b"\x7fELF" and data[4] == 2, "Invalid native 64-bit ELF library")
                endian = "<" if data[5] == 1 else ">"
                offset = struct.unpack_from(endian + "Q", data, 32)[0]
                entry_size, count = struct.unpack_from(endian + "HH", data, 54)
                alignments = [struct.unpack_from(endian + "Q", data, offset + i * entry_size + 48)[0]
                              for i in range(count) if struct.unpack_from(endian + "I", data, offset + i * entry_size)[0] == 1]
                require(bool(alignments) and all(value >= 16384 for value in alignments), f"64-bit ELF alignment is insufficient: {name}")
                native_alignment[name] = min(alignments)
        result = {
            "apk": apk.name, "sizeBytes": apk.stat().st_size,
            "sha256": hashlib.sha256(apk.read_bytes()).hexdigest(), "abis": abis,
            "offlineTileCount": len(tiles), "manifestFilesVerified": len(records),
            "manifestBytesVerified": verified_bytes,
            "cyrillicGlyphsPresent": True, "closureAdvisoryPresent": True,
            "native64BitElfLoadAlignment": native_alignment,
            **terrain_report, **landscape_report, **scope_report, **overview_report, **catalog_report, **map_resources_report,
            "terrainRendererSha256": json.loads(landscape_manifest)["rendererSha256"],
            "nativeHillshadeCameraRelative": True,
            "nativeHillshadeCameraAnchored": True,
            "nativeMapLibreTerrainMeshSupported": False,
            "separateLocalMeshViewer": True,
            "manropeFontBundled": True,
            "terrainTilesVerified": terrain_report["terrainTileCount"],
            "terrainAttributionAndLicensePresent": True,
            "sceneBytes": landscape_report["landscapeBytesVerified"],
            "sceneSha256": landscape_report["landscapeSha256"],
            "deviceUiTestPerformedByThisScript": False,
        }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("apk", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = verify_apk(args.apk)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
