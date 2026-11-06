"""Verify and wire the complete local cartographic RF overview, never a DEM."""
from __future__ import annotations

import json
import struct
from asset_integrity import AssetError, digest, require, safe_relative, verify_files


OVERVIEW_SIDECARS = ("manifest.json", "tilejson.json", "ATTRIBUTION.txt")
OVERVIEW_SOURCE = "russia-overview-relief"
OVERVIEW_LAYER = "russia-overview-relief"
OVERVIEW_TILES = "asset://maps/russia-relief/{z}/{x}/{y}.png"
OVERVIEW_SOURCES_HEADING = "ОБЗОРНЫЙ РЕЛЬЕФ РОССИИ"


def verify_overview(manifest_bytes: bytes, read, *, actual_files=None,
                    style: dict | None = None, provenance_bytes: bytes | None = None) -> dict:
    manifest = json.loads(manifest_bytes)
    count, size = verify_files(manifest, read)
    require(manifest.get("terrainElevationData") is False and manifest.get("navigationReady") is False,
            "Overview must not be advertised as elevation or navigation data")
    require(manifest.get("tileScheme") == "xyz" and manifest.get("tileSize") == 256
            and manifest.get("minzoom") == 0 and manifest.get("maxzoom") == 4
            and manifest.get("maxNativeZoom") == 4 and manifest.get("wrapX") is True,
            "Unexpected overview tile scheme or dateline wrapping")
    expected = {f"{z}/{x}/{y}.png" for z in range(5) for x in range(2 ** z) for y in range(2 ** z)}
    present = {safe_relative(entry["path"]) for entry in manifest["files"]}
    require(present == expected and count == manifest.get("tileCount") == 341,
            "Overview does not cover every XYZ tile at z0 through z4")
    require(size == manifest.get("totalTileBytes"), "Overview byte count differs")
    for relative in sorted(present):
        data = read(relative)
        require(len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR"
                and struct.unpack(">II", data[16:24]) == (256, 256), "Invalid overview PNG tile")
    try:
        tilejson_bytes = read("tilejson.json")
        attribution_bytes = read("ATTRIBUTION.txt")
    except (FileNotFoundError, KeyError) as error:
        raise AssetError("Overview metadata or attribution is missing") from error
    tilejson = json.loads(tilejson_bytes)
    require(tilejson.get("scheme") == "xyz" and tilejson.get("tiles") == [manifest.get("tileTemplate")]
            and tilejson.get("tiles") == ["/maps/russia-relief/{z}/{x}/{y}.png"]
            and tilejson.get("minzoom") == 0 and tilejson.get("maxzoom") == 4
            and tilejson.get("bounds") == manifest.get("bounds"), "Overview TileJSON does not match its manifest")
    require(manifest.get("bounds") == [-180, -85.0511287798066, 180, 85.0511287798066],
            "Overview bounds must retain both sides of the dateline")
    attribution = attribution_bytes.decode("utf-8")
    require(manifest.get("source", {}).get("license") == "Public Domain"
            and manifest.get("mask", {}).get("license") == "ODbL-1.0"
            and bool(manifest.get("attribution")) and manifest["attribution"] in attribution
            and "https://www.naturalearthdata.com/about/terms-of-use/" in attribution
            and "https://opendatacommons.org/licenses/odbl/1-0/" in attribution,
            "Overview source attribution or licence is incomplete")
    if actual_files is not None:
        require(set(actual_files) == present | set(OVERVIEW_SIDECARS), "Unlisted or missing overview package files")
    if provenance_bytes is not None:
        provenance = json.loads(provenance_bytes)
        require(manifest["mask"].get("provenanceSha256") == digest(provenance_bytes)
                and manifest["mask"].get("sha256") == provenance["assets"]["russia-canonical-area.geojson"]["sha256"],
                "Overview belongs to another RF display mask")
    if style is not None:
        source = style["sources"].get(OVERVIEW_SOURCE, {})
        require(source.get("type") == "raster" and source.get("tiles") == [OVERVIEW_TILES]
                and source.get("scheme") == "xyz" and source.get("tileSize") == 256
                and source.get("minzoom") == 0 and source.get("maxzoom") == 4
                and source.get("bounds") == manifest["bounds"], "Native overview must use only the bundled raster tiles")
        layers = style["layers"]
        ids = [layer["id"] for layer in layers]
        require(ids.count(OVERVIEW_LAYER) == 1 and "land" in ids and "russia-outside-mask" in ids,
                "Native overview or mask layer is missing/duplicated")
        index = ids.index(OVERVIEW_LAYER)
        layer = layers[index]
        require(layer.get("type") == "raster" and layer.get("source") == OVERVIEW_SOURCE
                and layer.get("minzoom") == 0 and layer.get("maxzoom") == 6,
                "Native overview must disappear at detailed zoom")
        protected = [i for i, item in enumerate(layers) if item.get("source") in {"regions", "admin-boundaries", "route", "focus", "position"}
                     or item.get("type") == "symbol" or item.get("id") == "russia-outside-mask"]
        require(ids.index("land") < index and all(index < i for i in protected)
                and ids[-1] == "russia-outside-mask", "Overview must stay below regional labels, routes and the RF mask")
        require(style.get("metadata", {}).get("tropnik:russiaReliefManifestSha256") == digest(manifest_bytes),
                "Native style and overview package differ")
    return {"russiaOverviewTileCount": count, "russiaOverviewTileBytesVerified": size,
            "russiaOverviewFilesVerified": count + len(OVERVIEW_SIDECARS),
            "russiaOverviewManifestSha256": digest(manifest_bytes),
            "russiaOverviewTilejsonSha256": digest(tilejson_bytes),
            "russiaOverviewAttributionSha256": digest(attribution_bytes),
            "russiaOverviewMaxNativeZoom": 4, "russiaOverviewLayerMaxZoom": 6,
            "russiaOverviewLocalOnly": True, "russiaOverviewCompleteWrappedXYZ": True,
            "russiaOverviewIsElevationData": False}


def add_overview_style(style: dict, manifest_bytes: bytes) -> dict:
    manifest = json.loads(manifest_bytes)
    style["sources"][OVERVIEW_SOURCE] = {
        "type": "raster", "tiles": [OVERVIEW_TILES], "scheme": "xyz", "tileSize": 256,
        "minzoom": 0, "maxzoom": 4, "bounds": manifest["bounds"], "attribution": manifest["attribution"],
    }
    layers = [layer for layer in style["layers"] if layer["id"] != OVERVIEW_LAYER]
    land = next((i for i, layer in enumerate(layers) if layer["id"] == "land"), None)
    require(land is not None, "Native overview needs the existing land layer")
    layers.insert(land + 1, {"id": OVERVIEW_LAYER, "type": "raster", "source": OVERVIEW_SOURCE,
                           "minzoom": 0, "maxzoom": 6,
                           "paint": {"raster-opacity": ["interpolate", ["linear"], ["zoom"], 0, 1, 4, 1, 6, 0],
                                     "raster-fade-duration": 200}})
    style["layers"] = layers
    style.setdefault("metadata", {})["tropnik:russiaReliefManifestSha256"] = digest(manifest_bytes)
    return style


def add_overview_sources(existing: bytes, manifest_bytes: bytes, attribution_bytes: bytes) -> bytes:
    source = json.loads(manifest_bytes)["source"]
    text = existing.decode("utf-8").split("\n" + OVERVIEW_SOURCES_HEADING, 1)[0].rstrip()
    block = ("\n\n" + OVERVIEW_SOURCES_HEADING + "\n"
             f"{source['name']}, использована версия {source['usedVersion']}. Картографический масштаб 1:50 000 000, не разрешение 50 метров.\n"
             "341 локальный PNG тайл z0–4 включён в APK; более крупные масштабы используют этот же обзор, слой скрывается на zoom 6.\n"
             "Полная XYZ-сетка включает прозрачные тайлы и обе стороны линии перемены даты. Сеть для этого слоя не требуется.\n"
             "Это исторический тонированный обзорный рисунок рельефа, не DEM, актуальная съёмка, текущий свет или подробная навигационная карта всей России.\n"
             "Маска покрытия совпадает с maps/russia/russia-boundaries-provenance.json.\n"
             "Происхождение и SHA256: maps/russia-relief/manifest.json; атрибуция: maps/russia-relief/ATTRIBUTION.txt.\n\n"
             + attribution_bytes.decode("utf-8").strip() + "\n")
    return (text + block).encode("utf-8")
