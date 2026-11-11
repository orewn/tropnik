#!/usr/bin/env python3
"""Independent spatial audit and primary-response spotcheck of the supplement.

This script never imports the production importer. It checks every published
line against the display mask and territorial polygons, then checks a fixed,
geographically varied sample against raw member ways using an independent
inverse Mercator formula. It does not establish field conditions, access,
safety, or exhaustive coverage of physical trails.

Requires Shapely. Defaults resolve from the repository, not a local workspace.
Use --raw-root with the directory containing raw/ from the verified source
archive when the untracked acquisition cache is unavailable.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

from shapely.geometry import MultiLineString, shape
from shapely.ops import transform, unary_union
from shapely.prepared import prep


ROOT = Path(__file__).resolve().parents[2]


def read(path):
    return json.loads(path.read_text())


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_members(raw):
    """Walk the response independently; preserve source order and separate ways."""
    stack = [raw['route']]
    ways = {}
    while stack:
        item = stack.pop()
        if isinstance(item, list):
            stack.extend(reversed(item))
        elif isinstance(item, dict):
            geometry = item.get('geometry') or {}
            if item.get('route_type') == 'base' and geometry.get('type') == 'LineString':
                xy = geometry['coordinates']
                if len(xy) >= 2:
                    key = (item.get('id'), tuple(tuple(point) for point in xy))
                    # atan(sinh()) is algebraically equivalent to the inverse
                    # used by the importer but calculated independently here.
                    ways[key] = [
                        [round(point[0] * 180 / (math.pi * 6378137), 7),
                         round(math.atan(math.sinh(point[1] / 6378137)) * 180 / math.pi, 7)]
                        for point in xy
                    ]
            stack.extend(reversed([
                value for key, value in item.items()
                if key != 'geometry' and isinstance(value, (dict, list))
            ]))
    return list(ways.values()), [key[0] for key in ways]


def audit(root, data_root, raw_root):
    inputs = {
        'catalog': data_root / 'routes.json',
        'geometry': data_root / 'routes.geojson',
        'territories': root / 'web/public/data/territories.geojson',
        'displayArea': root / 'web/public/data/russia-display-area.geojson',
    }
    records = read(inputs['catalog'])['routes']
    features = read(inputs['geometry'])['features']
    regions = {
        f['properties']['territoryId']: (f['properties']['name'], shape(f['geometry']))
        for f in read(inputs['territories'])['features']
    }
    area = prep(unary_union([
        shape(f['geometry']) for f in read(inputs['displayArea'])['features']
    ]))
    by_id = {record['osmId']: record for record in records}
    feature_ids = [f['properties']['osmId'] for f in features]
    errors = []

    def check(condition, message, osm_id=None):
        if not condition:
            errors.append({'osmId': osm_id, 'error': message})

    check(len(feature_ids) == len(set(feature_ids)) == len(records) == len(by_id),
          'Duplicate or mismatched route counts')
    check(set(feature_ids) == set(by_id), 'Feature and catalog identities differ')
    coverage = Counter()
    touch_only = []
    for feature in features:
        properties = feature['properties']
        osm_id = properties['osmId']
        coordinates = feature['geometry']['coordinates']
        valid = feature['geometry']['type'] == 'MultiLineString' and bool(coordinates) and all(
            len(line) >= 2 and all(
                len(point) == 2
                and all(isinstance(value, (int, float)) and math.isfinite(value) for value in point)
                and -180 <= point[0] <= 180 and -85 <= point[1] <= 85
                for point in line
            ) for line in coordinates
        )
        check(valid, 'Invalid finite WGS84 member geometry', osm_id)
        if not valid:
            continue
        geometry = MultiLineString(coordinates)
        check(all(abs(a[0] - b[0]) <= 180 for line in coordinates for a, b in zip(line, line[1:])),
              'Unsplit member crosses the longitude wrap', osm_id)
        check(list(geometry.bounds) == properties['bbox'], 'Bounds do not cover the entire geometry', osm_id)
        shifted = transform(lambda x, y, z=None: (x + 360 if x < 0 else x, y), geometry)
        check(area.covers(shifted), 'Geometry leaves the selected display area', osm_id)
        actual_memberships = []
        for territory_id, (name, region) in regions.items():
            if region.intersects(shifted):
                actual_memberships.append(territory_id)
                if region.intersection(shifted).length == 0:
                    touch_only.append({'osmId': osm_id, 'territoryId': territory_id, 'territoryName': name})
                else:
                    coverage[territory_id] += 1
        check(set(actual_memberships) == set(properties['territoryIds']),
              'Territory membership differs from polygon intersection', osm_id)
        check(not any(properties.get(key) for key in
                      ('fieldVerified', 'navigationReady', 'accessPermissionVerified')),
              'Unjustified verification claim', osm_id)
        check(properties.get('officialDistanceKm') is None,
              'OSM segment sum promoted to official itinerary distance', osm_id)
        check(properties.get('sourceUrl') == f'https://www.openstreetmap.org/relation/{osm_id}',
              'Primary relation URL does not match the relation ID', osm_id)
        check(properties.get('license') == 'ODbL-1.0'
              and properties.get('attribution') == '© OpenStreetMap contributors',
              'License or source attribution differs', osm_id)

    selected = set()
    for name in ('Астраханская область', 'Республика Саха (Якутия)', 'Курганская область',
                 'Свердловская область', 'Новгородская область', 'Красноярский край'):
        eligible = [f for f in features if any(
            regions[tid][0] == name for tid in f['properties']['territoryIds'] if tid in regions
        )]
        if eligible:
            selected.add(min(eligible, key=lambda f: f['properties']['osmId'])['properties']['osmId'])
    for key in ('segmentCount', 'pointCount', 'geometryLengthKm'):
        if features:
            selected.add(max(features, key=lambda f: f['properties'][key])['properties']['osmId'])
    if features:
        selected.add(min(features, key=lambda f: f['properties']['geometryLengthKm'])['properties']['osmId'])
        selected.add(min(features, key=lambda f: f['properties']['bbox'][0])['properties']['osmId'])
        selected.add(max(features, key=lambda f: f['properties']['bbox'][2])['properties']['osmId'])
    by_feature = {f['properties']['osmId']: f for f in features}
    samples = []
    for osm_id in sorted(selected):
        record = by_id[osm_id]
        feature = by_feature[osm_id]
        error_count = len(errors)
        try:
            relative = Path(record['sourceRawPath'])
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('Unsafe raw response path')
            path = raw_root / relative
            raw_bytes = path.read_bytes()
            raw = json.loads(raw_bytes)
            check(raw.get('id') == osm_id, 'Wrong raw relation ID', osm_id)
            check(hashlib.sha256(raw_bytes).hexdigest() == record['sourceRawSha256'],
                  'Raw response hash differs', osm_id)
            expected, way_ids = source_members(raw)
            actual = feature['geometry']['coordinates']
            check(actual == expected, 'Coordinates differ from original member ways', osm_id)
            check(record['osmWayIds'] == way_ids, 'Member way IDs or order differ', osm_id)
            check(sum(map(len, actual)) == record['pointCount'], 'Point count differs', osm_id)
            check(len(actual) == record['segmentCount'], 'Segment count differs', osm_id)
            check(read(data_root / record['geometryPath'])['features'] == [feature],
                  'Individual and combined geometry differ', osm_id)
            samples.append({
                'osmId': osm_id, 'title': record['title'],
                'territories': [regions[tid][0] for tid in record['territoryIds']],
                'sourceUrl': record['sourceUrl'], 'segments': len(actual),
                'points': record['pointCount'], 'geometryLengthKm': record['geometryLengthKm'],
                'sourceSha256': record['sourceRawSha256'],
                'geometryMatchesOriginalMembers': len(errors) == error_count,
            })
        except (KeyError, ValueError, OSError, OverflowError, TypeError) as error:
            check(False, f'Primary-response sample could not be checked: {error}', osm_id)

    return {
        'schemaVersion': 1,
        'checkedAt': datetime.now(timezone.utc).isoformat(),
        'scope': 'Independent spatial and primary-response checks; no field/access/safety verification.',
        'auditorSha256': sha256(Path(__file__)),
        'inputSha256': {name: sha256(path) for name, path in inputs.items()},
        'nationalRoutes': len(features),
        'territoriesWithPositiveLengthNewGeometry': len(coverage),
        'boundaryTouchOnlyMemberships': touch_only,
        'sampleCount': len(samples), 'samples': samples,
        'errors': errors, 'status': 'failed' if errors else 'passed',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT, help='Repository root')
    parser.add_argument('--data-root', type=Path, help='Directory containing national routes.json and routes.geojson')
    parser.add_argument('--raw-root', type=Path, help='Directory containing raw/ from the source snapshot')
    parser.add_argument('--output', type=Path, help='JSON audit receipt path')
    args = parser.parse_args()
    root = args.root.resolve()
    data_root = (args.data_root or root / 'data/catalog/national').resolve()
    raw_root = (args.raw_root or data_root).resolve()
    output = args.output or root / 'docs/verification/national-route-independent-audit-0.4.24.json'
    result = audit(root, data_root, raw_root)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in
                      ('status', 'nationalRoutes', 'territoriesWithPositiveLengthNewGeometry', 'sampleCount', 'errors')},
                     ensure_ascii=False))
    raise SystemExit(0 if result['status'] == 'passed' else 1)


if __name__ == '__main__':
    main()
