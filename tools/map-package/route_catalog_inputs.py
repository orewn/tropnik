"""Read all committed imported route collections used to protect map detail.

The historical six-destination extract is only one input. New collections,
including the national supplement, must participate in both coverage builders.
Raw acquisition responses are not catalogue output and are deliberately ignored.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path


def linear_geometry(geometry, depth=0):
    if not isinstance(geometry, dict) or depth > 16:
        return False
    kind = geometry.get('type')
    if kind == 'GeometryCollection':
        parts = geometry.get('geometries')
        return isinstance(parts, list) and bool(parts) and all(linear_geometry(part, depth + 1) for part in parts)
    lines = [geometry.get('coordinates')] if kind == 'LineString' else geometry.get('coordinates') if kind == 'MultiLineString' else None
    return isinstance(lines, list) and bool(lines) and all(
        isinstance(line, list) and len(line) >= 2 and all(
            isinstance(point, list) and len(point) >= 2 and all(
                isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
                for value in point) for point in line) for line in lines)


def load_route_catalogs(root: Path):
    directory = root / 'data/catalog'
    primary = directory / 'routes.geojson'
    if not primary.is_file():
        raise ValueError('The original route collection is missing')
    paths = sorted(path for path in directory.rglob('routes.geojson')
                   if 'raw' not in path.relative_to(directory).parts)
    routes, inputs = {}, []
    for path in paths:
        body = path.read_bytes()
        document = json.loads(body)
        if document.get('type') != 'FeatureCollection' or not isinstance(document.get('features'), list):
            raise ValueError(f'Invalid route collection: {path}')
        seen = set()
        for feature in document['features']:
            properties = feature.get('properties') or {}
            identifier = properties.get('id')
            geometry = feature.get('geometry') or {}
            if feature.get('type') != 'Feature' or not isinstance(identifier, str) or not identifier:
                raise ValueError(f'Route collection has a feature without an identity: {path}')
            if not linear_geometry(geometry):
                raise ValueError(f'Invalid or non-linear route geometry: {identifier}')
            if identifier in seen:
                raise ValueError(f'Duplicate route identity within {path}: {identifier}')
            seen.add(identifier)
            previous = routes.get(identifier)
            if previous is not None and previous['geometry'] != geometry:
                raise ValueError(f'Conflicting route geometry across collections: {identifier}')
            if previous is None:
                routes[identifier] = feature
        inputs.append({'path': str(path.relative_to(root)), 'bytes': len(body),
                       'sha256': hashlib.sha256(body).hexdigest(),
                       'routeCount': len(document['features'])})
    # Bind provenance to every catalogue byte source, not just the old extract.
    fingerprint = hashlib.sha256(json.dumps(inputs, ensure_ascii=False, sort_keys=True,
                                            separators=(',', ':')).encode()).hexdigest()
    return list(routes.values()), {'catalogInputs': inputs,
                                  'catalogSha256': fingerprint,
                                  'catalogFingerprintEncoding': 'sha256-json-sorted-compact-input-receipts-v1',
                                  'routeCount': len(routes)}
