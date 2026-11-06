"""Check the complete native reference catalogue and its unchanged source geometry."""
from __future__ import annotations

import json
import math
from asset_integrity import AssetError, digest, require, safe_relative

REGIONS = {"altai", "krasnodar", "karelia", "krym", "baikal", "kamchatka"}
ONLINE_SOURCES = {
    "online-openmaptiles": {"type": "vector", "url": "https://tiles.openfreemap.org/planet/latest"},
    "online-dem": {"type": "raster-dem", "tiles": ["https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"]},
}


def _vertices(geometry):
    kind = geometry.get("type")
    if kind == "FeatureCollection":
        return sum(_vertices(feature) for feature in geometry.get("features", []))
    if kind == "Feature":
        return _vertices(geometry.get("geometry", {}))
    require(kind in {"LineString", "MultiLineString"}, "Catalogue geometry is not a trail line")
    lines = [geometry.get("coordinates")] if kind == "LineString" else geometry.get("coordinates")
    require(isinstance(lines, list) and bool(lines), "Catalogue geometry has no segments")
    count = 0
    for line in lines:
        require(isinstance(line, list) and len(line) >= 2, "Catalogue segment is incomplete")
        for point in line:
            require(isinstance(point, list) and len(point) >= 2
                    and all(isinstance(x, (float, int)) and not isinstance(x, bool) and math.isfinite(x) for x in point)
                    and -180 <= point[0] <= 180 and -90 <= point[1] <= 90, "Invalid catalogue coordinate")
            count += 1
    return count


def verify_catalog(manifest_bytes: bytes, read, *, actual_geometry=None, source_read=None) -> dict:
    manifest = json.loads(manifest_bytes)
    require(manifest.get("schemaVersion") == 1, "Unsupported catalogue manifest")
    record = manifest.get("catalog", {})
    require(record.get("path") == "catalog.json", "Unexpected catalogue entrypoint")
    catalog_bytes = read("catalog.json")
    require(len(catalog_bytes) == record.get("bytes") and digest(catalog_bytes) == record.get("sha256"),
            "Catalogue bytes differ from the manifest")
    catalog = json.loads(catalog_bytes)
    require(catalog.get("schemaVersion") == 1, "Unsupported catalogue schema")
    regions = catalog.get("regions", [])
    require(len(regions) == 6 and {r.get("id") for r in regions} == REGIONS
            and set(manifest.get("regionIds", [])) == REGIONS, "Native catalogue does not cover the six reference regions")
    routes = catalog.get("routes", [])
    ids = [route.get("id") for route in routes]
    require(len(ids) == len(set(ids)), "Duplicate native route")
    references = {route["id"]: route for route in routes if route.get("illustrative") is False}
    learning = {route["id"] for route in routes if route.get("illustrative") is True}
    require(len(references) == 277 and learning == {"learning-route"}
            and set(manifest.get("referenceRouteIds", [])) == references.keys()
            and set(manifest.get("learningRouteIds", [])) == learning, "Native/web reference route parity differs")
    require(not set(manifest.get("excludedRouteIds", [])).intersection(ids), "An excluded outside-scope route is bundled")
    require(manifest.get("fieldVerifiedCount") == 0 and manifest.get("navigationReadyCount") == 0,
            "Manifest promotes unreviewed routes")
    membership = {region: 0 for region in REGIONS}
    for route in routes:
        require(route.get("fieldVerified") is False and route.get("navigationReady") is False,
                "Reference catalogue claims field verification or navigation approval")
        region_ids = route.get("regionIds")
        require(isinstance(region_ids, list) and bool(region_ids) and len(region_ids) == len(set(region_ids))
                and set(region_ids) <= REGIONS and route.get("regionId") in region_ids, "Route region membership differs")
        if route["id"] in references:
            for region in region_ids:
                membership[region] += 1
            require(route.get("durationMinutes") is None, "Reference duration was invented as an exact number")
            require(route.get("durationText") is None or isinstance(route["durationText"], str), "Invalid duration text")
            distance = route.get("distanceMeters")
            require(distance is None or isinstance(distance, (int, float)) and math.isfinite(distance) and distance >= 0,
                    "Invalid reference distance")
        else:
            require(route.get("geometryAsset") is None, "Learning example contains a purported trail")
    records = manifest.get("files", [])
    require(len(records) == len(references), "Missing native route geometry")
    seen_ids, seen_paths, size, vertices = set(), set(), 0, 0
    for record in records:
        route_id = record.get("routeId")
        path = safe_relative(record.get("path"))
        require(route_id in references and route_id not in seen_ids and path not in seen_paths
                and path.startswith("maps/routes/") and path.endswith(".geojson")
                and references[route_id].get("geometryAsset") == path, "Geometry is missing or assigned to another route")
        seen_ids.add(route_id)
        seen_paths.add(path)
        try:
            data = read(path)
        except (KeyError, FileNotFoundError) as error:
            raise AssetError("Missing route geometry: " + path) from error
        require(len(data) == record.get("bytes") and digest(data) == record.get("sha256"), "Route geometry bytes changed: " + path)
        size += len(data)
        vertices += _vertices(json.loads(data))
        source_path = safe_relative(record.get("sourcePath"))
        if source_read is not None:
            require(source_read(source_path) == data, "Native route geometry differs from its web source: " + source_path)
    require(all(membership.values()), "A reference region contains no route")
    if actual_geometry is not None:
        require(set(actual_geometry) == seen_paths, "Unlisted or stale native route geometry")
    for record in manifest.get("sourceInputs", []):
        path = safe_relative(record.get("path"))
        if source_read is not None:
            data = source_read(path)
            require(len(data) == record.get("bytes") and digest(data) == record.get("sha256"), "Catalogue input changed: " + path)
    return {"catalogManifestSha256": digest(manifest_bytes), "catalogSha256": digest(catalog_bytes),
            "catalogRegionCount": len(regions), "catalogReferenceRouteCount": len(references),
            "catalogLearningRouteCount": len(learning), "catalogGeometryFilesVerified": len(records),
            "catalogGeometryBytesVerified": size, "catalogGeometryVerticesVerified": vertices,
            "catalogRegionMembership": membership, "catalogFieldVerifiedCount": 0, "catalogNavigationReadyCount": 0,
            "catalogSourceByteParityVerified": source_read is not None}


def verify_map_resources(style: dict) -> dict:
    """Permit exactly two explicit online sources; all offline resources stay local."""
    for key in ("glyphs", "sprite"):
        require(not style.get(key) or style[key].startswith("asset://"), "Native fonts/sprites are not local")
    sources = style.get("sources", {})
    require({key for key in sources if key.startswith("online-")} == ONLINE_SOURCES.keys(), "Unexpected online source set")
    remote_urls = []
    for source_id, source in sources.items():
        urls = [source[field] for field in ("url", "data") if isinstance(source.get(field), str)] + source.get("tiles", [])
        if source_id in ONLINE_SOURCES:
            expected = ONLINE_SOURCES[source_id]
            require(all(source.get(key) == value for key, value in expected.items()), "Online map endpoint differs from its allowlist")
            allowed = ([expected["url"]] if "url" in expected else []) + expected.get("tiles", [])
            require(urls == allowed, "Unexpected online map resource")
            remote_urls += urls
        else:
            require(all(url.startswith("asset://") for url in urls), "Unexpected remote resource in a local map source")
    dem = sources["online-dem"]
    require(dem.get("encoding") == "terrarium" and dem.get("tileSize") == 512 and dem.get("maxzoom") == 12,
            "Online elevation encoding or resolution differs")
    layers = style.get("layers", [])
    online = [(i, layer) for i, layer in enumerate(layers) if layer.get("id", "").startswith("online-")]
    require(bool(online) and layers[-1]["id"] == "russia-outside-mask", "Online map lacks the final RF mask")
    pilot_start = min(i for i, layer in enumerate(layers) if layer.get("source") in {"openmaptiles", "pilot-dem"})
    for index, layer in enumerate(layers):
        if layer.get("source") in ONLINE_SOURCES:
            require(layer.get("id", "").startswith("online-") and layer.get("minzoom", 0) >= 5
                    and index < pilot_start, "Online map overlays local pilot data or leaks into overview")
    hillshade = [layer for _, layer in online if layer.get("id") == "online-hillshade"]
    require(len(hillshade) == 1 and hillshade[0].get("source") == "online-dem"
            and hillshade[0].get("paint", {}).get("hillshade-illumination-anchor") == "viewport", "Online hillshade is not camera anchored")
    return {"localOnlyMapResources": False, "bundledOfflineMapAvailable": True,
            "onlineMapSourcesExplicitlyAllowlisted": True, "onlineMapSourceUrls": remote_urls,
            "onlineMapLayerCount": len(online), "onlineMapMinZoom": 5, "russiaMaskAboveOnlineMap": True}
