#!/usr/bin/env python3
"""Verify native APK assets without claiming a device navigation test.

Checks bundled offline bytes, full catalogue, shared font coverage and the explicit
online source allowlist. Android signature/ZIP alignment are checked separately
with the SDK apksigner and zipalign tools by build.sh.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
from pathlib import Path
import zipfile
from asset_integrity import require, safe_relative, verify_landscape, verify_terrain
from display_scope import PROVENANCE_FILE, verify_display_scope
from russia_relief import OVERVIEW_SOURCES_HEADING, verify_overview
from catalog_integrity import verify_catalog
from map_coverage import verify_coverage
from custom_map import verify_custom_map
from online_sources import verify_online_sources
from pilot_map import verify_pilot


def verify_source_assets(archive: zipfile.ZipFile, source_root: Path) -> dict:
    """Bind source assets to checkout; account for AGP's two binary ART profiles."""
    root = source_root.resolve() / "android/app/src/main/assets"
    require(root.is_dir(), "Native source assets are missing")
    expected = {}
    for path in root.rglob("*"):
        require(not path.is_symlink(), "Linked source asset is not permitted")
        if path.is_file():
            expected["assets/" + path.relative_to(root).as_posix()] = path
    actual = {name for name in archive.namelist() if name.startswith("assets/") and not name.endswith("/")}
    # AGP compiles library profiles into release assets. These are compiler
    # outputs, not editable map/catalogue data. No other extra asset is admitted.
    profiles = {"assets/dexopt/baseline.prof": b"pro\x00", "assets/dexopt/baseline.profm": b"prm\x00"}
    generated = actual - set(expected)
    require(generated <= set(profiles) and set(expected) <= actual, "APK/source asset inventory differs")
    compiler_assets = []
    for name in sorted(generated):
        data = archive.read(name)
        require(8 <= len(data) <= 1_500_000 and data[:4] == profiles[name]
                and re.fullmatch(rb"[0-9]{3}\x00", data[4:8]) is not None, "Invalid compiler ART profile")
        profile_kind = "art_profile_metadata" if name.endswith(".profm") else "art_profile"
        compiled = source_root.resolve() / "android/app/build/intermediates" / profile_kind / "release/compileReleaseArtProfile" / name.rsplit("/", 1)[1]
        require(compiled.is_file() and not compiled.is_symlink() and compiled.read_bytes() == data,
                "APK ART profile differs from this Gradle compiler output")
        compiler_assets.append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                                "compilerOutput": compiled.relative_to(source_root.resolve()).as_posix()})
    total = 0
    for name, path in expected.items():
        source = path.read_bytes()
        require(archive.read(name) == source, "APK asset differs from the reviewed source: " + name)
        total += len(source)
    return {"sourceAssetsCompared": len(expected), "sourceAssetBytesCompared": total,
            "sourceAssetParityVerified": True, "compilerGeneratedArtProfiles": compiler_assets}


def verify_apk(apk: Path, *, source_root: Path | None = None) -> dict:
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "Duplicate APK entry")
        require(archive.testzip() is None, "APK CRC failure")
        source_report = verify_source_assets(archive, source_root) if source_root is not None else {"sourceAssetParityVerified": False}
        custom_map_report = verify_custom_map(archive.read("assets/custom-map/manifest.json"),
            lambda path: archive.read("assets/" + path),
            actual_files=[name.removeprefix("assets/") for name in names if name.startswith("assets/custom-map/") and not name.endswith("/")])
        require(not any("libmaplibre" in name.lower() or "libmapbox" in name.lower() for name in names),
                "A vendor native map renderer is still packaged")
        for name in names:
            if re.fullmatch(r"classes\d*\.dex", name):
                require(not any(prefix in archive.read(name) for prefix in (b"Lorg/maplibre/", b"Lcom/mapbox/mapboxsdk/")), "A vendor map SDK is still packaged")
        prefix = "assets/maps/pilot/"
        pilot_report = verify_pilot(archive.read(prefix + "manifest.json"),
            lambda path: archive.read(prefix + path),
            actual_files=[name[len(prefix):] for name in names if name.startswith(prefix) and not name.endswith("/")])
        require("assets/maps/style.json" not in names and not any(
            name.startswith(prefix + "fonts/") or re.search(r"(?:^|/)(?:maplibre|leaflet|protomaps)[^/]*\.(?:js|mjs|css)$", name, re.I)
            for name in names), "A retired map style, glyph atlas or vendor runtime is packaged")
        online_report = verify_online_sources(archive.read("assets/maps/online-sources.json"),
            lambda path: archive.read("assets/" + path))
        scope_prefix = "assets/maps/russia/"
        scope_report = verify_display_scope(archive.read(scope_prefix + PROVENANCE_FILE),
            lambda path: archive.read(scope_prefix + path))
        coverage_prefix = "assets/maps/coverage/"
        coverage_report = verify_coverage(archive.read(coverage_prefix + "manifest.json"),
            lambda path: archive.read(coverage_prefix + path),
            actual_files=[name[len(coverage_prefix):] for name in names if name.startswith(coverage_prefix) and not name.endswith("/")])
        overview_prefix = "assets/maps/russia-relief/"
        overview_report = verify_overview(archive.read(overview_prefix + "manifest.json"),
            lambda path: archive.read(overview_prefix + path),
            actual_files=[name[len(overview_prefix):] for name in names if name.startswith(overview_prefix) and not name.endswith("/")],
            provenance_bytes=archive.read(scope_prefix + PROVENANCE_FILE))
        require(OVERVIEW_SOURCES_HEADING in archive.read("assets/SOURCES.txt").decode("utf-8"),
                "Overview attribution is not reachable in the native sources dialog")
        terrain_prefix = "assets/maps/terrain-pilot/"
        terrain_manifest = archive.read(terrain_prefix + "manifest.json")
        terrain_report = verify_terrain(terrain_manifest,
            lambda path: archive.read(terrain_prefix + path),
            actual_files=[name[len(terrain_prefix):] for name in names if name.startswith(terrain_prefix) and not name.endswith("/")])
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
            **pilot_report, **online_report,
            "closureAdvisoryPresent": True,
            "native64BitElfLoadAlignment": native_alignment,
            **terrain_report, **landscape_report, **scope_report, **overview_report, **catalog_report, **coverage_report, **custom_map_report,
            "terrainRendererSha256": json.loads(landscape_manifest)["rendererSha256"],
            "mapReliefRenderer": "own-terrarium-worker",
            "mapReliefLighting": "geographic",
            "mapProjectedTiltDegrees": [0, 40],
            "separateLocalMeshViewer": True,
            "manropeFontBundled": True,
            "terrainTilesVerified": terrain_report["terrainTileCount"],
            "terrainAttributionAndLicensePresent": True,
            "sceneBytes": landscape_report["landscapeBytesVerified"],
            "sceneSha256": landscape_report["landscapeSha256"],
            "deviceUiTestPerformedByThisScript": False,
            **source_report,
        }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("apk", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--source-root", type=Path)
    args = parser.parse_args()
    result = verify_apk(args.apk, source_root=args.source_root)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
