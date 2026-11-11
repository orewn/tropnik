"""Verify the compact, canonical map-display selection included in Android."""
from __future__ import annotations

import json
import math
from asset_integrity import digest, require

NATIVE_SCOPE_FILES = ("russia-canonical-area.geojson", "russia-canonical-mask.geojson")
PROVENANCE_FILE = "russia-boundaries-provenance.json"


def verify_display_scope(provenance_bytes: bytes, read) -> dict:
    metadata = json.loads(provenance_bytes)
    require(metadata.get("schemaVersion") == 1 and metadata.get("validation", {}).get("passed") is True,
            "Display selection has not passed its source checks")
    require(metadata.get("license") == "ODbL-1.0" and bool(metadata.get("attribution")), "Display attribution is missing")
    for field in ("fitBounds", "recommendedMaxBounds"):
        value = metadata.get(field)
        require(isinstance(value, list) and len(value) == 2
                and all(isinstance(point, list) and len(point) == 2 for point in value), "Invalid display bounds")
        west, south = value[0]; east, north = value[1]
        require(all(isinstance(v, (int, float)) and math.isfinite(v) for v in (west, south, east, north))
                and 0 <= west < east <= 360 and -85.051129 <= south < north <= 85.051129,
                "Display bounds are outside their eastward domain")
    verified_bytes = 0
    for name in NATIVE_SCOPE_FILES:
        record = metadata["assets"][name]
        data = read(name)
        require(len(data) == record["bytes"] and digest(data) == record["sha256"], "Display selection changed: " + name)
        collection = json.loads(data)
        require(collection.get("type") == "FeatureCollection" and len(collection["features"]) == record["features"],
                "Invalid display GeoJSON: " + name)
        require(all(feature.get("geometry", {}).get("type") in {"Polygon", "MultiPolygon"}
                    for feature in collection["features"]), "Non-polygon display geometry")
        verified_bytes += len(data)
    return {"russiaDisplayAssetCount": 2, "russiaDisplayAssetBytesVerified": verified_bytes,
            "russiaDisplayProvenanceSha256": digest(provenance_bytes),
            "russiaFitBounds": metadata["fitBounds"],
            "russiaExcludedCatalogRouteIds": metadata.get("excludedCatalogRouteIds", [])}
