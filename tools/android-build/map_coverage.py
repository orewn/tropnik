"""Bind the native offline LOD cells to the exact shared, sourced map package."""
from __future__ import annotations

import copy
import json
import math
import re

from asset_integrity import digest, require, safe_relative

ENCODING = "indexed-delta-1e7-v1"
SOURCE_ID = "tropnik-map-coverage"
PREFIX = "/data/map-coverage/"
ROLES = {"area", "mask", "territory", "territory-boundary"}


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode()


def relative(record):
    url = record.get("url", "")
    require(isinstance(url, str) and url.startswith(PREFIX), "Coverage URL is outside its bundle")
    path = safe_relative(url[len(PREFIX):])
    require(re.fullmatch(r"(?:cells/)?[a-zA-Z0-9_.-]+\.coverage", path) is not None, "Unexpected coverage filename")
    return path


def records(manifest):
    require(manifest.get("schemaVersion") == 1 and re.fullmatch(r"[a-f0-9]{16}", manifest.get("version", "")), "Invalid coverage manifest")
    require([level.get("id") for level in manifest.get("levels", [])] == ["overview", "regional", "local", "source"], "Incomplete coverage LODs")
    cells = manifest.get("cells", [])
    require(isinstance(cells, list) and cells and len({cell["id"] for cell in cells}) == len(cells), "Duplicate coverage cell")
    for cell in cells:
        bounds = cell.get("bounds")
        require(isinstance(bounds, list) and len(bounds) == 4 and all(type(v) in (int, float) and math.isfinite(v) for v in bounds), "Invalid coverage cell bounds")
        w, s, e, n = bounds
        require(0 <= w < e <= 360 and -85.051129 <= s < n <= 85.051129 and not w < 180 < e, "Coverage cell crosses native canonical seam")
        require(set(cell.get("levels", {})) in (set(), {"regional", "local", "source"}), "Incomplete coverage cell levels")
    result = [manifest["base"]] + [record for cell in cells for record in cell["levels"].values()]
    paths = [relative(record) for record in result]
    require(len(paths) == len(set(paths)), "Duplicate coverage asset")
    return result


def decode(data, manifest, *, canonical=True):
    """The shared lossless format; accumulators span a file, never a ring."""
    document = json.loads(data)
    require(document.get("type") == "TropnikCoverage" and document.get("encoding") == ENCODING
            and document.get("coverageVersion") == manifest["version"], "Coverage encoding/version differs")
    positions = document.get("positions")
    require(isinstance(positions, list) and positions and len(positions) % 2 == 0 and all(type(v) is int for v in positions), "Invalid delta coordinates")
    points = []
    x = y = 0
    for i in range(0, len(positions), 2):
        x += positions[i]; y += positions[i + 1]
        require(0 <= x <= 3_600_000_000 and -850_511_290 <= y <= 850_511_290, "Decoded coverage coordinate outside display world")
        points.append([x / 1e7, y / 1e7])
    cells = {cell["id"]: cell for cell in manifest["cells"]}

    def coordinates(value, shift):
        if isinstance(value, list):
            return [coordinates(child, shift) for child in value]
        require(type(value) is int and 0 <= value < len(points), "Coverage coordinate index is invalid")
        point = points[value]
        return [round(point[0] + shift, 7), point[1]]

    features = document.get("features")
    require(isinstance(features, list) and features, "Empty coverage cell")
    for feature in features:
        properties = feature.get("properties", {})
        require(properties.get("cell") in cells and properties.get("role") in ROLES, "Unknown coverage role/cell")
        geometry = feature.get("geometry", {})
        expected = {"LineString", "MultiLineString"} if properties["role"] == "territory-boundary" else {"Polygon", "MultiPolygon"}
        require(geometry.get("type") in expected, "Invalid coverage role geometry")
        shift = -360 if canonical and cells[properties["cell"]]["bounds"][0] >= 180 else 0
        geometry["coordinates"] = coordinates(geometry["coordinates"], shift)
    return {"type": "FeatureCollection", "coverageVersion": manifest["version"], "features": features}


def native_package(source_manifest_bytes, read):
    source = json.loads(source_manifest_bytes)
    files = {}
    for record in records(source):
        path = relative(record); data = read(path)
        require(len(data) == record.get("bytes") and digest(data) == record.get("sha256"), "Shared map coverage changed: " + path)
        files[path] = data
    base = encoded(decode(files[relative(source["base"])], source))
    files["native-base.geojson"] = base
    manifest = copy.deepcopy(source)
    manifest.update({"nativeDecoder": ENCODING, "sourceManifestSha256": digest(source_manifest_bytes),
                     "nativeBase": {"path": "native-base.geojson", "bytes": len(base), "sha256": digest(base)}})
    files["source-manifest.json"] = source_manifest_bytes
    files["manifest.json"] = encoded(manifest)
    return files


def add_coverage_style(style, manifest_bytes):
    manifest = json.loads(manifest_bytes)
    style["sources"].pop(SOURCE_ID, None)
    style["sources"][SOURCE_ID] = {"type": "geojson", "data": "asset://maps/coverage/native-base.geojson",
                                    "tolerance": 0, "maxzoom": 18, "attribution": manifest["attribution"]}
    # The coarse world outline cannot describe the new sourced coastline.
    # Administrative outlines already contain real country/coastal edges.
    style["layers"] = [layer for layer in style["layers"] if layer["id"] != "borders"]
    for layer in style["layers"]:
        role = {"land": "area", "admin-boundary-lines": "territory-boundary", "russia-outside-mask": "mask"}.get(layer["id"])
        if role:
            layer["source"] = SOURCE_ID
            layer["filter"] = ["==", ["get", "role"], role]
    style.setdefault("metadata", {})["tropnik:coverageManifestSha256"] = digest(manifest_bytes)
    return style


def verify_coverage(manifest_bytes, read, *, actual_files=None, style=None):
    manifest = json.loads(manifest_bytes)
    require(manifest.get("nativeDecoder") == ENCODING, "Native coverage decoder contract differs")
    source_bytes = read("source-manifest.json")
    require(digest(source_bytes) == manifest.get("sourceManifestSha256"), "Native coverage is not bound to its shared manifest")
    source = json.loads(source_bytes)
    require(all(manifest.get(key) == value for key, value in source.items()), "Native coverage changed a shared contract field")
    expected = {"manifest.json", "source-manifest.json", "native-base.geojson"}
    total = 0
    for record in records(manifest):
        path = relative(record); data = read(path)
        require(len(data) == record.get("bytes") and digest(data) == record.get("sha256"), "Native coverage asset changed: " + path)
        expected.add(path); total += len(data)
    base = read("native-base.geojson")
    require(manifest.get("nativeBase") == {"path": "native-base.geojson", "bytes": len(base), "sha256": digest(base)}, "Native overview receipt differs")
    require(base == encoded(decode(read(relative(manifest["base"])), manifest)), "Native overview differs from its sourced canonical conversion")
    if actual_files is not None:
        require(set(actual_files) == expected, "Unlisted or missing coverage asset")
    if style is not None:
        require(style.get("metadata", {}).get("tropnik:coverageManifestSha256") == digest(manifest_bytes), "Native style uses another coverage bundle")
        require(style["sources"].get(SOURCE_ID, {}).get("data") == "asset://maps/coverage/native-base.geojson", "Native map does not initialize its sourced mask")
        for layer_id, role in [("land", "area"), ("admin-boundary-lines", "territory-boundary"), ("russia-outside-mask", "mask")]:
            layers = [layer for layer in style["layers"] if layer["id"] == layer_id]
            require(len(layers) == 1 and layers[0].get("source") == SOURCE_ID and layers[0].get("filter") == ["==", ["get", "role"], role], "Native map coverage roles differ")
    return {"mapCoverageVersion": manifest["version"], "mapCoverageSourceManifestSha256": manifest["sourceManifestSha256"],
            "mapCoverageFilesVerified": len(expected), "mapCoverageBytesVerified": total + len(base),
            "mapCoverageAllLevelsBundled": True, "mapCoverageDecodedOnlyForViewport": True}
