#!/usr/bin/env python3
"""Build bounded, source-derived coverage cells for the shared map renderers.

The selected source features and two inland-water inclusions are unchanged.
Simplification is measured in the renderer's Mercator plane and is bounded by
0.35 CSS pixels at the top zoom of each level. The closest level keeps source
geometry. Cells contain their land, inverse mask, administrative fill and real
administrative boundary lines together; clipping edges are never outlines.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import MultiPolygon, Point, Polygon, box, mapping, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[2]
R = 6378137.0
WORLD = 2 * math.pi * R
MAX_LAT = 85.0511287798066
SOURCE_COMMIT = '9469f09592ced973a3448cf66b6100b741b64c0d'
SOURCES = {
    'RUS': ('b86ab28823569a4ec881091b0c8608ae31194cb2b195943b8b34fbd56f492320', 83),
    'UKR': ('b2f9f4ad2e9be5888523219c0bb46a24332ead16b46305409098048fd361a2d6', 27),
}
CRIMEA = {'Autonomous Republic of Crimea', 'Sevastopol'}
LEVELS = [
    {'id': 'overview', 'minZoom': -2, 'maxZoom': 4, 'toleranceMercatorMeters': WORLD / (512 * 2**4) * .35},
    {'id': 'regional', 'minZoom': 4, 'maxZoom': 8, 'toleranceMercatorMeters': WORLD / (512 * 2**8) * .35},
    {'id': 'local', 'minZoom': 8, 'maxZoom': 12, 'toleranceMercatorMeters': WORLD / (512 * 2**12) * .35},
    {'id': 'source', 'minZoom': 12, 'maxZoom': 18, 'toleranceMercatorMeters': 0},
]


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def project(geometry):
    return shapely.transform(geometry, lambda xy: np.column_stack((
        xy[:, 0] * math.pi / 180 * R,
        np.arcsinh(np.tan(xy[:, 1] * math.pi / 180)) * R)))


def unwrap(geometry):
    return shapely.transform(geometry, lambda xy: np.column_stack((
        xy[:, 0] + 360 * np.floor((105 - xy[:, 0]) / 360 + .5), xy[:, 1])))


def geographic(geometry):
    return shapely.transform(geometry, lambda xy: np.column_stack((
        xy[:, 0] / R * 180 / math.pi,
        np.arctan(np.sinh(xy[:, 1] / R)) * 180 / math.pi)))


def polygon_parts(geometry):
    if geometry.geom_type == 'Polygon':
        return [geometry] if not geometry.is_empty else []
    return [p for g in getattr(geometry, 'geoms', []) for p in polygon_parts(g)]


def polygonal(geometry):
    parts = polygon_parts(geometry)
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)


def linear(geometry):
    if geometry.geom_type in ('LineString', 'LinearRing'):
        return [geometry] if not geometry.is_empty else []
    return [p for g in getattr(geometry, 'geoms', []) for p in linear(g)]


def geometry_json(geometry):
    value = mapping(geographic(geometry))
    def rounded(coords):
        if isinstance(coords, (tuple, list)):
            return [rounded(c) for c in coords]
        return round(coords, 7) if isinstance(coords, float) else coords
    value['coordinates'] = rounded(value['coordinates'])
    return value


def feature(cell, role, geometry, properties=None):
    props = {'cell': cell, 'role': role, **(properties or {})}
    identifier = f"{cell}:{role}:{props.get('shapeID', '')}"
    return {'type': 'Feature', 'id': identifier, 'properties': props, 'geometry': geometry_json(geometry)}


def collection(features, version, cell=None, lod=None):
    return {'type': 'FeatureCollection', 'coverageVersion': version,
            **({'cell': cell} if cell else {}), **({'lod': lod} if lod else {}), 'features': features}


def packed(document):
    """Lossless point interning; source precision and geometry nesting survive.

    The flat position table stores delta integer lon/lat pairs, scaled by 1e7.
    Delta state starts at (0, 0) once per file. Each geometry coordinate pair
    becomes its zero-based position index. Coordinates, never ring structure,
    are shared between the four roles. This avoids shipping the same coast
    four times without changing a single source vertex.
    """
    positions, lookup = [], {}
    previous = [0, 0]
    def intern(coordinates):
        if len(coordinates) == 2 and isinstance(coordinates[0], (int, float)):
            point = tuple(round(value * 10_000_000) for value in coordinates)
            index = lookup.get(point)
            if index is None:
                index = len(lookup); lookup[point] = index
                positions.extend([point[0] - previous[0], point[1] - previous[1]])
                previous[:] = point
            return index
        return [intern(child) for child in coordinates]
    features = [{**item, 'geometry': {**item['geometry'], 'coordinates': intern(item['geometry']['coordinates'])}}
                for item in document['features']]
    return {**document, 'type': 'TropnikCoverage', 'encoding': 'indexed-delta-1e7-v1',
            'positions': positions, 'features': features}


def load_sources(directory):
    sources, selected = [], []
    for iso, (expected, count) in SOURCES.items():
        path = directory / f'geoBoundaries-{iso}-ADM1.geojson'
        data = path.read_bytes()
        if sha(data) != expected:
            raise ValueError(f'Unreviewed {iso} source hash')
        document = json.loads(data)
        if len(document['features']) != count:
            raise ValueError('Source feature count changed')
        chosen = document['features'] if iso == 'RUS' else [f for f in document['features'] if f['properties']['shapeName'] in CRIMEA]
        sources.append({'iso': iso, 'sha256': expected, 'bytes': len(data),
                        'selectedFeatureCount': len(chosen), 'sourceCommit': SOURCE_COMMIT})
        for item in chosen:
            geometry = unwrap(shape(item['geometry']))
            if not geometry.is_valid:
                geometry = unary_union(polygon_parts(geometry))
            if not geometry.is_valid:
                raise ValueError('Invalid source geometry')
            selected.append({'geometry': geometry, 'properties': dict(item['properties'])})
    return sources, sorted(selected, key=lambda item: item['properties']['shapeID'])


def build(args):
    sources, selected = load_sources(args.source_dir)
    print('Dissolving the unchanged selected source...', flush=True)
    raw_area = polygonal(unary_union([item['geometry'] for item in selected]))
    holes = [Polygon(ring) for polygon in polygon_parts(raw_area) for ring in polygon.interiors]
    lakes = []
    for point in [(31.5, 60.8), (35.5, 61.8)]:
        matches = [hole for hole in holes if hole.covers(Point(point))]
        if len(matches) != 1:
            raise ValueError('Source inland water inclusion changed')
        lakes.append(matches[0])
    display_area = polygonal(unary_union([raw_area, *lakes]))
    full_area = project(display_area)
    territories = [{**item, 'geometry': project(item['geometry'])} for item in selected]
    full_shapes = [item['geometry'] for item in territories]
    full_lines = [geometry.boundary for geometry in full_shapes]
    index = STRtree(full_shapes)

    # Preserve the already established source detail around route envelopes.
    # A route can be fitted before its destination's cells have arrived.
    routes = json.loads((ROOT / 'data/catalog/routes.geojson').read_text())['features']
    windows = []
    for item in routes:
        west, south, east, north = unwrap(shape(item['geometry'])).bounds
        windows.append(project(box(west - .015, south - .015, east + .015, north + .015)))
    protected = unary_union(windows)
    protected_area = full_area.intersection(protected)
    configuration = {'schemaVersion': 1, 'sourceCommit': SOURCE_COMMIT, 'sources': sources,
                     'levels': LEVELS, 'maxCellVertices': args.max_cell_vertices,
                     'routeEnvelopePaddingDegrees': .015,
                     'routeCatalogSha256': sha((ROOT / 'data/catalog/routes.geojson').read_bytes()),
                     'sourceFeatureSelection': {'RUS': 'all 83 source features', 'UKR': sorted(CRIMEA)},
                     'inlandWaterInclusions': ['Lake Ladoga', 'Lake Onega'],
                     'coordinateDecimalPlaces': 7, 'encoding': 'indexed-delta-1e7-v1'}
    version = sha(encoded(configuration))[:16]
    cells = []

    def partition(identifier, bounds, depth=0):
        rectangle = project(box(*bounds))
        indices = list(index.query(rectangle, predicate='intersects'))
        area = polygonal(full_area.intersection(rectangle)) if indices or rectangle.intersects(full_area) else MultiPolygon([])
        land_vertices = len(shapely.get_coordinates(area))
        shape_vertices = sum(len(shapely.get_coordinates(full_shapes[i].intersection(rectangle))) for i in indices)
        weight = land_vertices * 2 + shape_vertices * 2
        if weight > args.max_cell_vertices and depth < 7:
            w, s, e, n = bounds; x = (w + e) / 2; y = (s + n) / 2
            for child, child_bounds in enumerate([(w,s,x,y),(x,s,e,y),(w,y,x,n),(x,y,e,n)]):
                partition(f'{identifier}{child}', child_bounds, depth + 1)
        else:
            cells.append({'id': identifier, 'bounds': bounds, 'rectangle': rectangle,
                          'indices': indices, 'detail': weight > 24, 'sourceVertices': weight})

    for x in range(24):
        south = -MAX_LAT; row = 0
        while south < MAX_LAT - 1e-8:
            north = min(south + 15, MAX_LAT)
            partition(f'{x:02x}{row:02x}-', (x*15, south, (x+1)*15, north))
            south = north; row += 1
    print(f'Partitioned into {len(cells)} cells, {sum(c["detail"] for c in cells)} with detailed boundaries.', flush=True)
    output = args.output; (output / 'cells').mkdir(parents=True, exist_ok=True)
    cells_manifest = [{k: cell[k] for k in ['id', 'bounds', 'sourceVertices']} | {'levels': {}} for cell in cells]
    base = []; totals = {}
    for level in LEVELS:
        name, tolerance = level['id'], level['toleranceMercatorMeters']
        print(f'Building {name}...', flush=True)
        if tolerance:
            simplified = full_area.simplify(tolerance, preserve_topology=True)
            area = polygonal(unary_union([simplified.difference(protected), protected_area]))
            shapes = [geometry.simplify(tolerance, preserve_topology=True) for geometry in full_shapes]
            lines = [geometry.simplify(tolerance, preserve_topology=True) for geometry in full_lines]
        else:
            area, shapes, lines = full_area, full_shapes, full_lines
        level_bytes = 0; level_vertices = 0; level_files = 0
        for cell, receipt in zip(cells, cells_manifest, strict=True):
            if name != 'overview' and not cell['detail']:
                continue
            identifier, rectangle = cell['id'], cell['rectangle']
            land = polygonal(area.intersection(rectangle))
            mask = polygonal(rectangle.difference(land))
            features = []
            if not land.is_empty:
                features.append(feature(identifier, 'area', land))
            if not mask.is_empty:
                features.append(feature(identifier, 'mask', mask))
            for i in cell['indices']:
                properties = territories[i]['properties'] | {'id': 'territory-' + territories[i]['properties']['shapeID']}
                polygon = polygonal(shapes[i].intersection(rectangle))
                if not polygon.is_empty:
                    features.append(feature(identifier, 'territory', polygon, properties))
                outline = linear(lines[i].intersection(rectangle))
                if outline:
                    geometry = shapely.geometry.MultiLineString(outline)
                    features.append(feature(identifier, 'territory-boundary', geometry, properties))
            # Test the actual rounded serialization, not merely the GEOS input.
            for item in features:
                actual = shape(item['geometry'])
                if not actual.is_valid:
                    raise ValueError(f'Invalid serialized {identifier}/{name}/{item["properties"]["role"]}: {shapely.is_valid_reason(actual)}')
            if name == 'overview':
                base.extend(features)
            else:
                data = encoded(packed(collection(features, version, identifier, name)))
                if len(data) > 3 * 1024 * 1024:
                    raise ValueError(f'Cell exceeds its 3 MiB transport bound: {identifier}/{name}')
                filename = f'cells/{identifier}{name}.coverage'
                (output / filename).write_bytes(data)
                receipt['levels'][name] = {'url': f'/data/map-coverage/{filename}', 'bytes': len(data), 'sha256': sha(data)}
                level_bytes += len(data); level_files += 1
            level_vertices += sum(len(shapely.get_coordinates(shape(item['geometry']))) for item in features)
        totals[name] = {'bytes': level_bytes, 'files': level_files, 'vertices': level_vertices}
    base_data = encoded(packed(collection(base, version, lod='overview')))
    if len(base_data) > 8 * 1024 * 1024:
        raise ValueError(f'Overview exceeds startup budget: {len(base_data)} bytes')
    (output / 'base.coverage').write_bytes(base_data)
    totals['overview']['bytes'] = len(base_data); totals['overview']['files'] = 1
    manifest = configuration | {
        'version': version, 'bounds': list(display_area.bounds), 'longitudeDomain': 'continuous around 105 degrees east',
        'base': {'url': '/data/map-coverage/base.coverage', 'bytes': len(base_data), 'sha256': sha(base_data)},
        'cells': cells_manifest, 'totals': totals, 'sourceDisplayVertices': len(shapely.get_coordinates(display_area)),
        'attribution': '© OpenStreetMap contributors · geoBoundaries (OpenStreetMap / Wambacher, 2017)',
        'license': 'ODbL-1.0', 'legalBoundaryClaim': False, 'navigationReady': False,
        'sourceURLs': [f'https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/{SOURCE_COMMIT}/releaseData/gbOpen/{iso}/ADM1/geoBoundaries-{iso}-ADM1.geojson' for iso in SOURCES],
        'limitations': ['Historical administrative source geometry can include coastal water; this is not a newly surveyed coastline.',
                        'The existing selected source features and two inland-water display inclusions are unchanged.',
                        'Source level retains the published geometry; smaller levels use the stated Mercator display tolerance.'],
        'regressionSourceVertices': {'primorsk': [28.6069513,60.3623846], 'gogland': [26.9596752,60.0633158]},
    }
    (output / 'manifest.json').write_bytes(encoded(manifest))
    expected = {Path(item['url']).name for cell in cells_manifest for item in cell['levels'].values()}
    for previous in (output / 'cells').glob('*.coverage'):
        if previous.name not in expected:
            previous.unlink()
    print(json.dumps({'version': version, 'cells': len(cells), 'totals': totals}, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, default=ROOT / 'data/boundaries/raw')
    parser.add_argument('--output', type=Path, default=ROOT / 'web/public/data/map-coverage')
    parser.add_argument('--max-cell-vertices', type=int, default=90000)
    args = parser.parse_args()
    if not 10000 <= args.max_cell_vertices <= 100000:
        raise SystemExit('Cell budget must stay between 10,000 and 100,000 vertices')
    build(args)


if __name__ == '__main__':
    main()
