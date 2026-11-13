#!/usr/bin/env python3
"""Apply explicit, reviewed geometry links to editorial route cards.

No name matching or routing is performed. The review file pins every source
and its bytes. Existing catalogue geometry is reused unchanged; official
tracks retain their source segments and vertices (only lon/lat order and
seven-decimal precision are normalized). A description never becomes a
field-verified or navigation-ready route by acquiring a map line.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
REVIEW = 'data/catalog/editorial-geometry-review.json'
OUTPUT = 'web/lib/editorial-geometry.generated.json'
EDITORIAL = ('national-editorial.generated.json', 'yandex-routes.generated.json',
             'discovery-routes.generated.json', 'russiadiscovery-east.generated.json')


def read(path: Path):
    return json.loads(path.read_text())


def digest(data: bytes):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()


def geometry_lines(value):
    kind = value.get('type')
    if kind == 'FeatureCollection':
        return [line for feature in value['features'] for line in geometry_lines(feature)]
    if kind == 'Feature':
        return geometry_lines(value['geometry']) if value.get('geometry') else []
    if kind == 'GeometryCollection':
        return [line for child in value['geometries'] for line in geometry_lines(child)]
    if kind == 'LineString':
        return [value['coordinates']]
    if kind == 'MultiLineString':
        return value['coordinates']
    raise ValueError('Source must contain line geometry, not an invented connection')


def checked_lines(lines):
    if not lines:
        raise ValueError('Source has no real line segments')
    for line in lines:
        if len(line) < 2:
            raise ValueError('Source contains a segment without two vertices')
        for point in line:
            if len(point) < 2 or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in point[:2]):
                raise ValueError('Invalid source coordinate')
            if not (-180 <= point[0] <= 180 and -85 <= point[1] <= 85):
                raise ValueError('Source coordinate outside supported WGS84 bounds')
        if any(abs(a[0] - b[0]) > 180 for a, b in zip(line, line[1:])):
            raise ValueError('Dateline crossing needs an explicit reviewed representation')
    return lines


def distance_m(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (*a[:2], *b[:2]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(min(1, math.sqrt(h)))


def line_metadata(lines):
    points = [point for line in lines for point in line]
    longest = max(lines, key=lambda line: sum(distance_m(a, b) for a, b in zip(line, line[1:])))
    return {
        'center': longest[len(longest) // 2][:2],
        'bbox': [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)],
        'geometryLengthKm': round(sum(distance_m(a, b) for line in lines for a, b in zip(line, line[1:])) / 1000, 3),
    }


def parse_gpx(data):
    # ElementTree does not expand remote entities; reject document declarations
    # entirely so externally supplied GPX is a bounded coordinate input only.
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('GPX document declarations are not allowed')
    root = ET.fromstring(data)
    if root.tag.split('}')[-1] != 'gpx':
        raise ValueError('Source is not GPX')
    lines = []
    for segment in root.iter():
        if segment.tag.split('}')[-1] not in ('trkseg', 'rte'):
            continue
        kind = 'trkpt' if segment.tag.split('}')[-1] == 'trkseg' else 'rtept'
        line = [[round(float(point.attrib['lon']), 7), round(float(point.attrib['lat']), 7)]
                for point in segment if point.tag.split('}')[-1] == kind]
        if line:
            lines.append(line)
    return checked_lines(lines)


def build(root: Path, review=None):
    review = review or read(root / REVIEW)
    if review.get('schemaVersion') != 1:
        raise ValueError('Unsupported geometry review schema')
    cards = {card['id']: card for name in EDITORIAL for card in read(root / 'web/lib' / name)['routes']}
    catalogue = {card['id']: card for card in read(root / 'web/lib/catalog.generated.json')}
    exclusions = set(read(root / 'web/public/data/russia-boundaries-provenance.json')['excludedCatalogRouteIds'])
    updates, files, audits, official_features = {}, {}, [], []
    for item in review['accepted']:
        ident = item['id']
        if ident in updates or ident not in cards:
            raise ValueError('Unknown or duplicate editorial route: ' + ident)
        if cards[ident].get('geometryUrl') or cards[ident].get('geometry'):
            raise ValueError('A reviewed link may not silently replace an existing track: ' + ident)
        if not item.get('evidence') or not item.get('reviewedAt'):
            raise ValueError('Geometry identity requires a dated explicit review')
        if item.get('geometryScope') != 'source_track':
            raise ValueError('A scheme or partial track cannot represent a complete editorial route: ' + ident)
        identity = item.get('identityReview', {})
        if identity.get('regionMatches') is not True or identity.get('fieldVerified') is not False or identity.get('navigationReady') is not False:
            raise ValueError('Source identity review must preserve reference-only status: ' + ident)
        if item['kind'] == 'existing_catalogue':
            source_id = item['sourceRouteId']
            if source_id in exclusions or source_id not in catalogue:
                raise ValueError('Source route is not in the active catalogue: ' + source_id)
            source = catalogue[source_id]
            if source['title'] != item['sourceTitle']:
                raise ValueError('Reviewed source route identity changed: ' + source_id)
            geometry_url = source['geometryUrl']
            source_bytes = (root / 'web/public' / geometry_url.lstrip('/')).read_bytes()
            if digest(source_bytes) != item['sourceSha256']:
                raise ValueError('Reviewed source geometry bytes changed: ' + source_id)
            lines = checked_lines(geometry_lines(json.loads(source_bytes)))
            source_kind, source_url, source_name = 'database', source['sourceUrl'], 'OpenStreetMap'
            geo_fields = {key: source[key] for key in ('center', 'bbox', 'geometryLengthKm', 'territoryIds') if key in source}
            geo_fields['geometrySourceTrailId'] = source_id
        elif item['kind'] == 'official_gpx':
            source_path = item['sourcePath']
            if not source_path.startswith('data/catalog/editorial-geometry/') or '..' in Path(source_path).parts:
                raise ValueError('Official source escaped the reviewed source directory')
            source_bytes = (root / source_path).read_bytes()
            if digest(source_bytes) != item['sourceSha256']:
                raise ValueError('Reviewed official source bytes changed: ' + ident)
            lines = parse_gpx(source_bytes)
            geometry_url = '/data/routes/' + ident + '.geojson'
            feature = {'type': 'Feature', 'properties': {'id': ident, 'title': cards[ident]['title'], 'sourceUrl': item['sourceUrl'],
                       'sourceName': item['sourceName'], 'retrievedAt': item['retrievedAt'],
                       'license': item['license'], 'geometryVerified': False, 'fieldVerified': False, 'navigationReady': False},
                       'geometry': {'type': 'MultiLineString', 'coordinates': lines}}
            files['web/public' + geometry_url] = encode({'type': 'FeatureCollection', 'features': [feature]})
            official_features.append(feature)
            source_kind, source_url, source_name = 'official', item['sourceUrl'], item['sourceName']
            geo_fields = line_metadata(lines)
        else:
            raise ValueError('Unsupported reviewed geometry source kind: ' + item['kind'])
        for anchor in item.get('endpointAnchors', []):
            endpoints = [p for line in lines for p in (line[0], line[-1])]
            if min(distance_m(anchor['coordinates'], p) for p in endpoints) > anchor['maximumDistanceM']:
                raise ValueError('Reviewed source endpoint no longer matches: ' + ident)
        if len(lines) != item['segmentCount'] or sum(map(len, lines)) != item['pointCount']:
            raise ValueError('Reviewed source segment/vertex inventory changed: ' + ident)
        updates[ident] = {'geometryUrl': geometry_url, **geo_fields,
                         'geometrySourceKind': source_kind, 'geometrySourceUrl': source_url,
                         'geometrySourceName': source_name, 'geometryReviewedAt': item['reviewedAt'],
                         'geometrySourceLicense': 'ODbL-1.0' if source_kind == 'database' else item['license'],
                         'geometryScope': item.get('geometryScope', 'source_track'),
                         'addNotes': item.get('notes', []), 'removeNotes': item.get('removeNotes', []),
                         'additionalSources': [{'url': source_url, 'name': source_name,
                             'reviewedAt': item['reviewedAt'], 'scope': 'geometry_download'}]}
        if item.get('sourceUrlUpdate'):
            updates[ident]['sourceUrl'] = item['sourceUrlUpdate']
        audits.append({'id': ident, 'geometryUrl': geometry_url, 'sourceKind': source_kind,
                       'segments': len(lines), 'vertices': sum(map(len, lines)),
                       'sourceSha256': item['sourceSha256']})
    unresolved = review['unresolved']
    if any(not item.get('reasonCode') or not item.get('reason') or not item.get('sourceReview') for item in unresolved):
        raise ValueError('Every unresolved route needs a source review and a specific remaining reason')
    if set(updates) & {item['id'] for item in unresolved}:
        raise ValueError('An editorial route cannot be linked and unresolved')
    if set(cards) != set(updates) | {item['id'] for item in unresolved} or len(unresolved) != len({item['id'] for item in unresolved}):
        raise ValueError('Every editorial card needs one explicit geometry review state')
    files[OUTPUT] = encode({'schemaVersion': 1, 'updatesByRouteId': updates})
    files['data/catalog/editorial/routes.geojson'] = encode({'type': 'FeatureCollection',
        'name': 'Reviewed official route tracks', 'features': official_features})
    files['data/catalog/editorial-geometry-audit.json'] = encode({
        'schemaVersion': 1, 'reviewSha256': digest(encode(review)), 'status': 'passed',
        'editorialCards': len(cards), 'linkedCards': len(updates), 'unresolvedCards': len(unresolved),
        'newUniqueGeometry': sum(item['kind'] != 'existing_catalogue' for item in review['accepted']),
        'unresolvedReasons': dict(sorted(Counter(item['reasonCode'] for item in unresolved).items())),
        'routes': audits, 'fieldVerifiedCount': 0, 'navigationReadyCount': 0,
        'scope': 'Source bytes, identity review and coordinate inventory only; not field or present-access verification.'})
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    files = build(ROOT)
    for relative, data in files.items():
        path = ROOT / relative
        if args.check:
            if not path.exists() or path.read_bytes() != data:
                raise SystemExit('Reviewed editorial geometry is stale: ' + relative)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    audit = json.loads(files['data/catalog/editorial-geometry-audit.json'])
    print(json.dumps({key: audit[key] for key in ('editorialCards', 'linkedCards', 'unresolvedCards', 'newUniqueGeometry')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
