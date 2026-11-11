"""Verify the exact shared renderer, workers and native resource registry.

"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from asset_integrity import require, safe_relative

PREFIX = "custom-map/"
REQUIRED_SOURCES = {
    "web/lib/custom-map-engine.ts", "web/lib/custom-map-camera.ts",
    "web/lib/custom-map-painter.ts", "web/lib/custom-map-vector.ts",
    "web/lib/custom-map-tiles.ts", "web/lib/custom-map-tiles.worker.ts",
    "web/public/maps/map-coverage-lod.js", "tools/android-build/custom-map-entry.ts",
    "tools/android-build/custom-map-android.ts", "tools/android-build/prepare-custom-map.mjs",
    "web/package.json", "web/pnpm-lock.yaml",
    *{f"tools/android-build/fonts/manrope-{subset}-{weight}-normal.woff2" for subset in ("latin", "cyrillic") for weight in (400, 600)},
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode()


def record_ok(record: dict) -> None:
    safe_relative(record.get("path"))
    require(type(record.get("sizeBytes")) is int and 0 < record["sizeBytes"] <= 16 * 1024 * 1024,
            "Invalid custom-map resource length")
    require(isinstance(record.get("sha256"), str) and re.fullmatch(r"[a-f0-9]{64}", record["sha256"]),
            "Invalid custom-map resource hash")


def verify_custom_map(manifest_bytes: bytes, read_asset, *, actual_files=None, source_root: Path | None = None) -> dict:
    manifest = json.loads(manifest_bytes)
    require(manifest.get("schemaVersion") == 1 and manifest.get("runtime") == "tropnik-canvas"
            and manifest.get("apiVersion") == 1, "Unknown custom-map runtime contract")
    require(manifest.get("compiler") == {"name": "vite", "version": "8.1.6"}, "Unreviewed custom-map compiler")
    require(manifest.get("origin") == "https://map.tropnik.invalid"
            and manifest.get("bridge") == "exact-origin-web-message-port-v1"
            and manifest.get("sceneIsSeparate") is True, "Map/landscape isolation contract differs")
    require(manifest.get("entry") == "map-runtime.js" and manifest.get("stylesheet") == "map.css"
            and manifest.get("androidEntry") == "index.html", "Shared map entry contract differs")
    require(manifest.get("networkHosts") == ["tiles.openfreemap.org", "tiles.mapterhorn.com", "tiles.maps.eox.at"]
            and manifest.get("fullRussiaDetailedOffline") is False, "Map source availability claim differs")
    inputs = manifest.get("sourceInputs")
    require(isinstance(inputs, list) and 12 <= len(inputs) <= 256, "Custom-map source inputs missing")
    require(digest(json_bytes(inputs)) == manifest.get("sourceInputsSha256"), "Custom-map input-set digest differs")
    paths = set()
    for record in inputs:
        record_ok(record)
        name = record["path"]
        require(name not in paths and "/node_modules/" not in name and not re.search(r"(?:^|/)(?:maplibre|mapbox|leaflet|protomaps|pmtiles)(?:[-/]|$)", name),
                "Repeated or vendor renderer source in custom-map runtime")
        paths.add(name)
        if source_root is not None:
            source = source_root / name
            require(source.is_file() and not source.is_symlink() and source.resolve().is_relative_to(source_root.resolve()),
                    "Missing or unsafe custom-map source input")
            data = source.read_bytes()
            require(len(data) == record["sizeBytes"] and digest(data) == record["sha256"], f"Custom-map source changed: {name}")
    require(REQUIRED_SOURCES <= paths, "Shared camera, decoder, painter or worker is not bound to the bundle")
    files = manifest.get("files")
    require(isinstance(files, list) and 5 <= len(files) <= 64, "Custom-map runtime file list missing")
    runtime = {}
    for record in files:
        record_ok(record)
        name = record["path"]
        require(name not in runtime and Path(name).suffix in {".js", ".css", ".json", ".html", ".txt", ".woff2"},
                "Unexpected or duplicate custom-map runtime output")
        data = read_asset(PREFIX + name)
        require(len(data) == record["sizeBytes"] and digest(data) == record["sha256"], f"Packaged map runtime differs: {name}")
        runtime[name] = data
    require({"map-runtime.js", "map.css", "android-bootstrap.js", "index.html", "offline-manifest.json", "Manrope-OFL.txt"} <= runtime.keys(),
            "Shared map bundle is incomplete")
    workers = [name for name in runtime if name.startswith("workers/") and name.endswith(".js")]
    require(any(name.startswith("workers/custom-map-tiles.worker-") for name in workers), "Own vector/DEM worker missing")
    for name, data in runtime.items():
        if name.endswith(".js"):
            require(b"file:///ROOT" not in data and b"node_modules/maplibre" not in data and b"node_modules/leaflet" not in data,
                    "Runtime contains an unresolved build URL or a vendor renderer")
    css = runtime["map.css"].decode()
    require(css.count("@font-face") == 4 and len(re.findall(r"U\+0?400-0?45F", css, re.I)) == 2
            and css.count("data:font/woff2;base64,") == 4, "Bundled shared map fonts omit Cyrillic or use external URLs")
    html = runtime["index.html"].decode()
    require('src="./android-bootstrap.js"' in html and 'href="./map.css"' in html and "frame-src 'none'" in html,
            "Standalone map document does not load the verified entry")
    if actual_files is not None:
        require(set(actual_files) == {PREFIX + name for name in runtime} | {PREFIX + "manifest.json"},
                "Unlisted or missing packaged custom-map runtime")
    aliases = manifest.get("resourceAliases")
    require(isinstance(aliases, list) and 500 <= len(aliases) <= 2048, "Native map resource registry missing")
    urls = set()
    vector = terrain = overview = coverage = 0
    for alias in aliases:
        record_ok(alias)
        url = alias.get("url", "")
        require(isinstance(url, str) and url.startswith("/") and url not in urls
                and safe_relative(url[1:]) and alias.get("assetPath") == alias["path"], "Unsafe or duplicated native map alias")
        path = alias["path"]
        if url == "/data/map-coverage/manifest.json":
            require(path == "maps/coverage/manifest.json", "Wrong coverage source manifest")
            coverage += 1
        elif url.startswith("/data/map-coverage/"):
            require(path == "maps/coverage/" + url.removeprefix("/data/map-coverage/"), "Coverage alias moved")
            coverage += 1
        elif url.startswith("/offline-map/localtiles/"):
            require(path == "maps/pilot/" + url.removeprefix("/offline-map/"), "Local vector alias moved")
            vector += 1
        elif url.startswith("/offline-map/terrain/tiles/"):
            require(path == "maps/terrain-pilot/tiles/" + url.removeprefix("/offline-map/terrain/tiles/"), "Local DEM alias moved")
            terrain += 1
        elif url.startswith("/maps/russia-relief/"):
            require(path == url[1:], "National overview alias moved")
            overview += 1
        else:
            raise ValueError("Unrecognized custom-map resource alias")
        data = read_asset(path)
        require(len(data) == alias["sizeBytes"] and digest(data) == alias["sha256"], f"Packaged map source differs: {path}")
        urls.add(url)
    require(vector == 193 and terrain == 21 and overview == 341 and coverage > 500,
            "Shared renderer cannot access every verified native map source")
    require(manifest.get("virtualResources") == [{"url": "/offline-map/manifest.json", "assetPath": "custom-map/offline-manifest.json"}],
            "Unknown dynamic map resource")
    offline = json.loads(runtime["offline-manifest.json"])
    expected_offline = [{"path": alias["url"].removeprefix("/offline-map/"), "size": alias["sizeBytes"], "sha256": alias["sha256"]}
                        for alias in aliases if alias["url"].startswith("/offline-map/")]
    require(offline.get("files") == expected_offline and offline.get("complete") is True
            and offline.get("fullRussiaDetailedOffline") is False, "Offline tile inventory differs from the native alias registry")
    return {"mapRenderer": "tropnik-canvas", "mapRendererManifestSha256": digest(manifest_bytes),
            "mapRendererSourceInputsSha256": manifest["sourceInputsSha256"],
            "mapRendererFilesVerified": len(runtime), "mapRendererWorkersVerified": len(workers),
            "mapRendererResourceAliasesVerified": len(aliases), "mapRendererSharedWithWeb": True,
            "mapRendererNativeSdkRequired": False, "mapRendererBridge": manifest["bridge"],
            "mapRendererCyrillicFontBundled": True,
            "mapRendererOfflineVectorTiles": vector, "mapRendererOfflineDemTiles": terrain}
