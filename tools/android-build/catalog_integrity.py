"""Check the complete native reference catalogue and its unchanged source geometry."""
from __future__ import annotations

import json
import math
import re
from urllib.parse import urlsplit
from asset_integrity import AssetError, digest, require, safe_relative

def _vertices(geometry):
    require(isinstance(geometry, dict), "Catalogue geometry is missing")
    kind = geometry.get("type")
    if kind == "FeatureCollection":
        features = geometry.get("features")
        require(isinstance(features, list) and bool(features), "Catalogue geometry has no features")
        return sum(_vertices(feature) for feature in features)
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


def _source_references(route):
    sources = route.get("additionalSources", [])
    require(isinstance(sources, list) and len(sources) <= 500, "Invalid additional source list")
    seen = set()
    for source in sources:
        require(isinstance(source, dict)
                and {"url", "name", "scope", "reviewedAt"} <= source.keys()
                and source.keys() <= {"url", "name", "scope", "reviewedAt", "publishedAt", "messageId"},
                "Additional source contains missing or private fields")
        url = source.get("url")
        require(isinstance(url, str) and len(url) <= 2048 and url not in seen, "Duplicate or invalid source URL")
        parsed = urlsplit(url)
        require(parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.password,
                "Additional source is not a public HTTPS reference")
        require(isinstance(source.get("name"), str) and 1 <= len(source["name"]) <= 240
                and source.get("scope") in {"community_mention", "editorial_mention", "official_description", "geometry_download"},
                "Invalid additional source description")
        for field in ("reviewedAt", "publishedAt"):
            value = source.get(field)
            require(value is None and field == "publishedAt" or isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:T[0-9:.+Z-]{8,30})?", value),
                    "Invalid additional source date")
        if source["scope"] == "community_mention":
            mid = source.get("messageId")
            require(type(mid) is int and 0 < mid <= 2_147_483_647 and url == f"https://t.me/poiskpohod/{mid}"
                    and source.get("publishedAt") is not None, "Community source lost its exact message provenance")
        seen.add(url)


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
    require(isinstance(regions, list) and 1 <= len(regions) <= 200, "Invalid catalogue region count")
    region_ids = [region.get("id") for region in regions]
    require(all(isinstance(value, str) and re.fullmatch(r"(?:[a-z0-9-]{1,64}|territory-[A-Za-z0-9]{1,54})", value) for value in region_ids)
            and len(set(region_ids)) == len(region_ids), "Duplicate or invalid curated region")
    region_set = set(region_ids)
    require(manifest.get("regionIds") == region_ids, "Native/web curated region parity differs")
    territory_ids = {value for value in region_ids if value.startswith("territory-")}
    for region in regions:
        require(type(region.get("territory", False)) is bool
                and region.get("territory", False) == (region["id"] in territory_ids),
                "Catalogue territory classification differs from its identity")
        require(all(isinstance(region.get(key), (int, float)) and not isinstance(region[key], bool) and math.isfinite(region[key])
                    for key in ("latitude", "longitude", "zoom"))
                and -90 <= region["latitude"] <= 90 and -180 <= region["longitude"] <= 180 and 0 <= region["zoom"] <= 22,
                "Invalid region overview coordinates")
    routes = catalog.get("routes", [])
    ids = [route.get("id") for route in routes]
    require(1 <= len(ids) <= 100_001 and all(isinstance(value, str) and re.fullmatch(r"[a-z0-9-]{1,128}", value) for value in ids)
            and len(ids) == len(set(ids)), "Duplicate or invalid native route")
    references = {route["id"]: route for route in routes if route.get("illustrative") is False}
    learning = {route["id"] for route in routes if route.get("illustrative") is True}
    require(bool(references) and learning == {"learning-route"}
            and manifest.get("referenceRouteIds") == list(references)
            and set(manifest.get("learningRouteIds", [])) == learning, "Native/web reference route parity differs")
    require(len(references) + len(learning) == len(routes), "Every native card must declare its reference or illustrative status")
    require(not set(manifest.get("excludedRouteIds", [])).intersection(ids), "An excluded outside-scope route is bundled")
    require(manifest.get("fieldVerifiedCount") == 0 and manifest.get("navigationReadyCount") == 0,
            "Manifest promotes unreviewed routes")
    membership = {region: 0 for region in region_ids}
    geometric, reference_only = set(), set()
    for route in routes:
        require(route.get("fieldVerified") is False and route.get("navigationReady") is False,
                "Reference catalogue claims field verification or navigation approval")
        region_ids = route.get("regionIds")
        require(isinstance(region_ids, list) and bool(region_ids) and len(region_ids) == len(set(region_ids))
                and set(region_ids) <= region_set and route.get("regionId") in region_ids, "Route region membership differs")
        if route["id"] in references:
            _source_references(route)
            require(route.get("publicationStatus") == "reference", "Bundled card changed its publication status")
            if route.get("geometryAsset") is None:
                reference_only.add(route["id"])
                require(all(route.get(key) is None for key in ("inlineGeometry", "center", "bbox", "geometryLengthKm")),
                        "Unlocated reference invents route geometry or location")
                require("OpenStreetMap" not in route.get("sourceLicense", ""), "Unlocated reference claims an OSM geometry licence")
            else:
                geometric.add(route["id"])
            for region in region_ids:
                membership[region] += 1
            require(route.get("durationMinutes") is None, "Reference duration was invented as an exact number")
            require(route.get("durationText") is None or isinstance(route["durationText"], str), "Invalid duration text")
            distance = route.get("distanceMeters")
            require(distance is None or isinstance(distance, (int, float)) and not isinstance(distance, bool) and math.isfinite(distance) and distance >= 0,
                    "Invalid reference distance")
        else:
            require(route.get("geometryAsset") is None, "Learning example contains a purported trail")
    records = manifest.get("files", [])
    require(isinstance(records, list) and len(records) == len(geometric), "Missing native route geometry")
    # Legacy fully geometric manifests remain verifiable. New manifests must
    # enumerate the deliberate geometry-free cards, so an accidentally missing
    # asset never becomes a reference card silently.
    require(set(manifest.get("referenceOnlyRouteIds", [])) == reference_only
            and len(manifest.get("referenceOnlyRouteIds", [])) == len(reference_only), "Reference-only route inventory differs")
    if "geometryRouteIds" in manifest:
        require(set(manifest["geometryRouteIds"]) == geometric and len(manifest["geometryRouteIds"]) == len(geometric),
                "Geometric route inventory differs")
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
    require(seen_ids == geometric, "Native geometry inventory is incomplete")
    if actual_geometry is not None:
        require(set(actual_geometry) == seen_paths, "Unlisted or stale native route geometry")
    overlay = manifest.get("trailOverlay", {})
    require(overlay.get("path") == "maps/catalogue/trail-overlay.json"
            and isinstance(overlay.get("sha256"), str) and re.fullmatch(r"[a-f0-9]{64}", overlay["sha256"])
            and overlay.get("url") == "/data/trail-overlay-" + overlay["sha256"][:16] + ".json"
            and overlay.get("sourcePath") == "web/public" + overlay["url"]
            and type(overlay.get("bytes")) is int and 0 < overlay["bytes"] <= 8 * 1024 * 1024,
            "Native trail overview contract missing or invalid")
    overlay_bytes = read(overlay["path"])
    require(len(overlay_bytes) == overlay["bytes"] and digest(overlay_bytes) == overlay["sha256"], "Native trail overview bytes changed")
    overview = json.loads(overlay_bytes)
    by_source = {}
    for record in records:
        key = record["sourcePath"].removeprefix("web/public/data/")
        entry = by_source.setdefault(key, {"ids": set(), "sha256": record["sha256"]})
        require(entry["sha256"] == record["sha256"], "Conflicting native geometry source")
        entry["ids"].add(record["routeId"])
    sources = overview.get("sources", [])
    require(overview.get("version") == 1 and len(sources) == len(by_source) == overlay.get("sourceCount")
            and len({source.get("key") for source in sources}) == len(sources), "Native trail overview source inventory differs")
    for source in sources:
        expected = by_source.get(source.get("key"))
        require(expected is not None and expected["sha256"] == source.get("sha256")
                and expected["ids"] == set(source.get("ids", [])), "Native trail overview identity or geometry differs")
    if source_read is not None:
        require(source_read(overlay["sourcePath"]) == overlay_bytes, "Native trail overview differs from its web source")
    inputs = manifest.get("sourceInputs", [])
    require(isinstance(inputs, list) and 6 <= len(inputs) <= 100, "Catalogue source input inventory is missing")
    input_paths = set()
    for record in inputs:
        path = safe_relative(record.get("path"))
        require(path not in input_paths and type(record.get("bytes")) is int and 0 < record["bytes"] <= 64 * 1024 * 1024
                and isinstance(record.get("sha256"), str) and re.fullmatch(r"[a-f0-9]{64}", record["sha256"]),
                "Invalid or duplicate catalogue source input")
        input_paths.add(path)
        if source_read is not None:
            data = source_read(path)
            require(len(data) == record.get("bytes") and digest(data) == record.get("sha256"), "Catalogue input changed: " + path)
    require({"tools/android-build/prepare-catalog.mjs", "tools/android-build/fixtures/learning-route.json", "web/lib/content.ts",
             "web/lib/catalog.generated.json", "web/lib/route-points.generated.json", "web/public/data/russia-boundaries-provenance.json"} <= input_paths,
            "Catalogue omits a required source input")
    require({"web/lib/trail-overlay.generated.json", overlay["sourcePath"]} <= input_paths,
            "Catalogue omits shared trail overview provenance")
    if territory_ids:
        require({"tools/android-build/catalog-regions.mjs", "web/lib/territories.generated.json"} <= input_paths,
                "Territory catalogue omits its membership source inputs")
    return {"catalogManifestSha256": digest(manifest_bytes), "catalogSha256": digest(catalog_bytes),
            "catalogRegionCount": len(regions), "catalogReferenceRouteCount": len(references),
            "catalogTourismDirectionCount": len(regions) - len(territory_ids), "catalogTerritoryCount": len(territory_ids),
            "catalogLearningRouteCount": len(learning), "catalogGeometryFilesVerified": len(records),
            "catalogReferenceOnlyRouteCount": len(reference_only),
            "catalogGeometryBytesVerified": size, "catalogGeometryVerticesVerified": vertices,
            "catalogTrailOverlaySourcesVerified": len(sources), "catalogTrailOverlayBytesVerified": len(overlay_bytes),
            "catalogRegionMembership": membership, "catalogFieldVerifiedCount": 0, "catalogNavigationReadyCount": 0,
            "catalogSourceByteParityVerified": source_read is not None}
