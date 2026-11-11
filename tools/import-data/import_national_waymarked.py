#!/usr/bin/env python3
"""Acquire a bounded, resumable WMT snapshot for every displayed territory.

This extends the six-destination snapshot without re-dating or replacing it.
OSM relations remain reference records. Original member segments are preserved.
Run `discover`, then `collect`; existing responses require matching SHA256.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import urllib.parse
import urllib.request

from shapely.geometry import box, shape, MultiLineString
from shapely.ops import transform, unary_union
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/catalog/national'
BASE = 'https://hiking.waymarkedtrails.org/api/v1'
MAX_BODY = 12_000_000
MAX_QUERIES = 512
MAX_DEPTH = 6
MAX_DETAILS = 4000
WORKERS = 2
UA = 'Tropnik-route-catalog/0.4.24 (https://github.com/orewn/tropnik)'
SPEC = importlib.util.spec_from_file_location('waymarked', Path(__file__).with_name('import_waymarked.py'))
WMT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WMT)


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = value if isinstance(value, bytes) else (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    temp = path.with_suffix(path.suffix + '.part')
    temp.write_bytes(data)
    temp.replace(path)


def read(path):
    return json.loads(path.read_text())


def fetch_json(url, relative):
    path = OUT / relative
    meta_path = path.with_suffix(path.suffix + '.source.json')
    if path.exists() and meta_path.exists():
        data, meta = path.read_bytes(), read(meta_path)
        if sha(data) != meta['sha256'] or len(data) != meta['bytes'] or meta['sourceUrl'] != url:
            raise ValueError('Cached source identity/hash mismatch: ' + str(relative))
    else:
        request = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json', 'Accept-Encoding': 'identity'})
        with urllib.request.urlopen(request, timeout=35) as response:
            data = response.read(MAX_BODY + 1)
            if len(data) > MAX_BODY:
                raise ValueError('Response exceeded 12 MB bound')
            if response.url != url:
                raise ValueError('Unexpected redirect from source API')
            meta = {'sourceUrl': url, 'retrievedAt': now(), 'bytes': len(data), 'sha256': sha(data),
                    'etag': response.headers.get('ETag'), 'lastModified': response.headers.get('Last-Modified'),
                    'license': 'ODbL-1.0', 'attribution': '© OpenStreetMap contributors'}
        json.loads(data)
        save(path, data)
        save(meta_path, meta)
    return json.loads(data), {'path': str(relative), **meta}


def territories():
    source = ROOT / 'web/public/data/territories.geojson'
    items = []
    for feature in read(source)['features']:
        p = feature['properties']
        geometry = shape(feature['geometry'])
        if not geometry.is_valid:
            raise ValueError('Invalid territory geometry: ' + p['territoryId'])
        items.append({'id': p['territoryId'], 'name': p['name'], 'shapeNames': [p['shapeName']], 'shape': geometry})
    return items, {'path': str(source.relative_to(ROOT)), 'sha256': sha(source.read_bytes()),
                   'scope': 'Existing project display territories; geographic data scope, not a legal boundary assertion.'}


def destination_memberships(territory_ids, regions):
    # Existing editorial directions are preserved. A region with no matching
    # direction stays attached to its real territory; none is fabricated.
    names = {'Altai Krai': 'altai', 'Altai Republic': 'altai', 'Krasnodar Krai': 'krasnodar',
             'Republic of Karelia': 'karelia', 'Autonomous Republic of Crimea': 'krym',
             'Sevastopol': 'krym', 'Irkutsk Oblast': 'baikal', 'Buryatia': 'baikal', 'Kamchatka Krai': 'kamchatka'}
    for region in read(ROOT / 'web/lib/editorial-regions.generated.json')['regions']:
        for name in region['shapeNames']:
            names[name] = region['id']
    return list(dict.fromkeys(names[name] for region in regions if region['id'] in territory_ids
                              for name in region.get('shapeNames', []) if name in names))


def query_extents(geometry):
    """Split the existing 0..360 geometry at 180 before using WMT EPSG:3857."""
    extents = []
    for west, east, shift in [(-180, 180, 0), (180, 360, -360)]:
        part = geometry.intersection(box(west, -85, east, 85))
        if not part.is_empty and part.area > 0:
            w, s, e, n = part.bounds
            extents.append([w + shift, s, e + shift, n])
    return extents


def query_overlaps(geometry, extent):
    w, s, e, n = extent
    return any(geometry.intersects(box(w + shift, s, e + shift, n)) for shift in (0, 360))


def get_list(task):
    tid, extent, depth = task
    xy = WMT.merc(extent[0], extent[1]) + WMT.merc(extent[2], extent[3])
    url = BASE + '/list/by_area?' + urllib.parse.urlencode({'bbox': ','.join(map(str, xy)), 'limit': 100})
    key = sha(url.encode())[:20]
    data, source = fetch_json(url, Path('raw/lists') / (key + '.json'))
    return task, data, source


def discover():
    items, provenance = territories()
    lookup = {r['id']: r for r in items}
    stats = {r['id']: {'name': r['name'], 'shapeNames': r['shapeNames'], 'queries': [], 'errors': [],
                      'saturatedLeafExtents': [], 'unqueriedSubareas': [], 'candidateIds': []} for r in items}
    pending = [(r['id'], extent, 0) for r in items for extent in query_extents(r['shape'])]
    candidates, sources = {}, {}
    query_count = 0
    # Breadth-first rounds ensure every territory receives its initial request
    # before a dense region can consume the finite subdivision budget.
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        while pending and query_count < MAX_QUERIES:
            batch = pending[:MAX_QUERIES - query_count]
            pending = pending[len(batch):]
            futures = {pool.submit(get_list, task): task for task in batch}
            query_count += len(batch)
            for future in as_completed(futures):
                tid, extent, depth = futures[future]
                stat = stats[tid]
                try:
                    _, data, source = future.result()
                    values = data.get('results')
                    if not isinstance(values, list):
                        raise ValueError('Source list has no results array')
                    sources[source['path']] = source
                    saturated = len(values) >= 100
                    stat['queries'].append({'bbox': extent, 'depth': depth, 'returned': len(values), 'atApiLimit': saturated,
                                            'sourcePath': source['path'], 'sourceUrl': source['sourceUrl'], 'sha256': source['sha256']})
                    for row in values:
                        if row.get('type') != 'relation' or not isinstance(row.get('id'), int):
                            continue
                        ident = row['id']
                        candidate = candidates.setdefault(ident, {'osmId': ident, 'name': row.get('name'), 'discoveredIn': []})
                        if tid not in candidate['discoveredIn']:
                            candidate['discoveredIn'].append(tid)
                        if ident not in stat['candidateIds']:
                            stat['candidateIds'].append(ident)
                    if saturated:
                        if depth >= MAX_DEPTH:
                            stat['saturatedLeafExtents'].append(extent)
                        else:
                            w, s, e, n = extent
                            mx, my = (w + e) / 2, (s + n) / 2
                            for child in ([w,s,mx,my], [mx,s,e,my], [w,my,mx,n], [mx,my,e,n]):
                                if query_overlaps(lookup[tid]['shape'], child):
                                    pending.append((tid, child, depth + 1))
                except Exception as error:
                    stat['errors'].append({'bbox': extent, 'depth': depth, 'error': str(error)})
                completed = sum(len(s['queries']) + len(s['errors']) for s in stats.values())
                if completed % 10 == 0:
                    print(json.dumps({'phase': 'discover', 'completed': completed, 'candidates': len(candidates),
                                      'pendingSubareas': len(pending), 'errors': sum(len(s['errors']) for s in stats.values())}), flush=True)
    for tid, extent, depth in pending:
        stats[tid]['unqueriedSubareas'].append({'bbox': extent, 'depth': depth})
    for stat in stats.values():
        stat['candidateIds'].sort()
        stat['queries'].sort(key=lambda row: (row['depth'], row['bbox']))
        stat['coverageStatus'] = 'bounded_query_complete' if not (stat['errors'] or stat['unqueriedSubareas'] or stat['saturatedLeafExtents']) else 'incomplete'
    known = {r['osmId'] for r in read(ROOT / 'data/catalog/routes.json')['routes']}
    result = {'schemaVersion': 1, 'createdAt': now(), 'boundarySource': provenance, 'territoryCount': len(items),
              'queryCount': query_count, 'candidateCount': len(candidates), 'alreadyCataloguedCount': len(set(candidates) & known),
              'newCandidateCount': len(set(candidates) - known), 'limits': {'queries': MAX_QUERIES, 'depth': MAX_DEPTH, 'details': MAX_DETAILS,
              'concurrentRequests': WORKERS, 'responseBytes': MAX_BODY, 'requestTimeoutSeconds': 35},
              'providerSelection': 'Top-level hiking route relations indexed by Waymarked Trails; not every physical path or child relation.',
              'regions': stats, 'candidates': sorted(candidates.values(), key=lambda row: row['osmId']),
              'rawSources': sorted(sources.values(), key=lambda row: row['path'])}
    save(OUT / 'discovery.json', result)
    print(json.dumps({key: result[key] for key in ('territoryCount','queryCount','candidateCount','alreadyCataloguedCount','newCandidateCount')}, ensure_ascii=False), flush=True)


def normalized_lines(data):
    items = []
    WMT.segments(data.get('route'), items, set())
    lines = [item['coordinates'] for item in items]
    for line in lines:
        if len(line) < 2 or any(len(p) != 2 or not all(math.isfinite(v) for v in p) or not (-180 <= p[0] <= 180 and -85 <= p[1] <= 85) for p in line):
            raise ValueError('Invalid WGS84 member geometry')
        # A wrapped dateline line needs a separate explicit review, never a
        # straight segment across the world or silently altered source points.
        if any(abs(a[0] - b[0]) > 180 for a, b in zip(line, line[1:])):
            raise ValueError('Dateline-crossing member needs explicit review')
    return items, lines


def normalize(ident, data, source, regions, display):
    if data.get('id') != ident:
        raise ValueError('Relation/source identity mismatch')
    if ident in WMT.SOURCE_EXCLUSIONS:
        return None, 'existing_primary_source_geographic_exclusion'
    tags = data.get('tags', {})
    if tags.get('route') not in ('hiking', 'foot', 'walking'):
        return None, 'route_type_not_hiking_foot_or_walking'
    items, lines = normalized_lines(data)
    if not items:
        return None, 'no_real_member_geometry'
    geometry = MultiLineString(lines)
    shifted = transform(lambda x, y, z=None: (x + 360 if x < 0 else x, y), geometry)
    if not display.covers(shifted):
        return None, 'not_wholly_inside_existing_display_coverage'
    memberships = [r['id'] for r in regions if r['shape'].intersects(shifted)]
    if not memberships:
        return None, 'outside_displayed_territories'
    title = tags.get('name:ru') or tags.get('name') or data.get('name') or f'Маршрут OSM {ident}'
    directions = destination_memberships(memberships, regions)
    properties = {'id': f'osm-relation-{ident}', 'osmId': ident, 'osmType': 'relation', 'sourceType': 'route',
                  'title': title, 'name': title, 'ref': tags.get('ref'), 'routeType': tags['route'],
                  'territoryIds': memberships, 'regionId': directions[0] if directions else memberships[0],
                  'regionIds': directions, 'sourceName': 'OpenStreetMap via Waymarked Trails',
                  'sourceUrl': f'https://www.openstreetmap.org/relation/{ident}', 'dataUrl': source['sourceUrl'],
                  'sourceRawPath': source['path'], 'sourceRawSha256': source['sha256'], 'retrievedAt': source['retrievedAt'],
                  'upstreamDataTimestamp': None, 'license': 'ODbL-1.0', 'licenseUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
                  'attribution': '© OpenStreetMap contributors', 'osmTags': tags,
                  'sourceWebsite': tags.get('website') or data.get('url'), 'sourceOperator': tags.get('operator') or data.get('operator'),
                  'sourceDifficultyTags': {k: tags[k] for k in ('sac_scale','trail_visibility','difficulty') if k in tags},
                  'waymarkedLinear': data.get('linear'), 'segmentCount': len(items), 'pointCount': sum(map(len, lines)),
                  'osmWayIds': [item['wayId'] for item in items], 'geometryLengthKm': WMT.length_km(lines),
                  'officialDistanceKm': None, 'duration': None, 'difficulty': None, 'conditions': None,
                  'conditionsStatus': 'requires_current_verification', 'conditionsVerifiedAt': None,
                  'elevationGainM': None, 'legalDifficultyCategory': None, 'navigationReady': False, 'fieldVerified': False,
                  'accessPermissionVerified': False, 'verificationStatus': 'source_only', 'publicationStatus': 'reference',
                  'indexable': False, 'ratings': None, 'reviewsCount': 0, 'activeTrips': 0,
                  'bbox': list(geometry.bounds), 'geometryNote': 'Unmodified real OSM member segments in WGS84 rounded to seven decimals. No joined gaps or inferred elevation. Segment sum is not official itinerary distance.'}
    return {'type': 'Feature', 'id': properties['id'], 'properties': properties,
            'geometry': {'type': 'MultiLineString', 'coordinates': lines}}, None


def get_detail(ident):
    data, source = fetch_json(BASE + f'/details/relation/{ident}', Path('raw/relations') / f'{ident}.json')
    return ident, data, source


def collect():
    discovery = read(OUT / 'discovery.json')
    regions, boundary_source = territories()
    if boundary_source != discovery['boundarySource']:
        raise ValueError('Display territory source changed since discovery')
    area_path = ROOT / 'web/public/data/russia-display-area.geojson'
    display = prep(unary_union([shape(f['geometry']) for f in read(area_path)['features']]))
    known = {r['osmId'] for r in read(ROOT / 'data/catalog/routes.json')['routes']}
    candidates = [r['osmId'] for r in discovery['candidates'] if r['osmId'] not in known]
    selected = candidates[:MAX_DETAILS]
    features, rejected, errors, sources = [], [], [], []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(get_detail, ident): ident for ident in selected}
        for future in as_completed(futures):
            ident = futures[future]
            try:
                _, data, source = future.result()
                sources.append(source)
                feature, reason = normalize(ident, data, source, regions, display)
                if feature:
                    features.append(feature)
                else:
                    rejected.append({'osmId': ident, 'reason': reason})
            except Exception as error:
                errors.append({'osmId': ident, 'error': str(error)})
            completed = len(features) + len(rejected) + len(errors)
            if completed % 25 == 0:
                print(json.dumps({'phase': 'collect', 'completed': completed, 'total': len(selected),
                                  'accepted': len(features), 'rejected': len(rejected), 'errors': len(errors)}), flush=True)
    features.sort(key=lambda f: f['properties']['osmId'])
    cards = []
    for feature in features:
        properties = dict(feature['properties'])
        path = 'geometry/' + properties['id'] + '.geojson'
        save(OUT / path, {'type': 'FeatureCollection', 'features': [feature]})
        cards.append({**properties, 'geometryPath': path})
    save(OUT / 'routes.json', {'schemaVersion': 1, 'createdAt': now(), 'routes': cards})
    save(OUT / 'routes.geojson', {'type': 'FeatureCollection', 'name': 'National source-only OSM route supplement',
                                'license': 'ODbL-1.0', 'attribution': '© OpenStreetMap contributors', 'features': features})
    counts = {r['id']: sum(r['id'] in f['properties']['territoryIds'] for f in features) for r in regions}
    report = {'schemaVersion': 1, 'createdAt': now(), 'source': BASE, 'license': 'ODbL-1.0',
              'boundarySource': boundary_source, 'displayCoverageSource': {'path': str(area_path.relative_to(ROOT)), 'sha256': sha(area_path.read_bytes())},
              'discoverySha256': sha((OUT / 'discovery.json').read_bytes()), 'baseCatalogSha256': sha((ROOT / 'data/catalog/routes.json').read_bytes()),
              'existingRouteCount': len(known), 'newCandidateCount': len(candidates), 'detailRequestsPlanned': len(selected),
              'detailsExcludedByGlobalBound': candidates[MAX_DETAILS:], 'acceptedRouteCount': len(features),
              'geometryVertices': sum(f['properties']['pointCount'] for f in features),
              'regions': {r['id']: {'name': r['name'], 'newRoutes': counts[r['id']], 'queryStatus': discovery['regions'][r['id']]['coverageStatus']} for r in regions},
              'requestFailures': sorted(errors, key=lambda e: e['osmId']), 'rejected': sorted(rejected, key=lambda r: r['osmId']),
              'rawSources': sorted(sources, key=lambda r: r['path']), 'navigationReadyCount': 0, 'fieldVerifiedCount': 0,
              'coordinateChanges': 'Only source Mercator to WGS84 conversion and rounding to seven decimal places; no simplification or artificial joins.',
              'selection': 'Every accepted new relation is wholly covered by the existing display polygon. Border/source-resolution exclusions remain explicit for editorial review.',
              'completenessClaim': False}
    save(OUT / 'import-report.json', report)
    print(json.dumps({k: report[k] for k in ('existingRouteCount','newCandidateCount','detailRequestsPlanned','acceptedRouteCount','geometryVertices')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['discover', 'collect'])
    args = parser.parse_args()
    globals()[args.phase]()
