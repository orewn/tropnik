#!/usr/bin/env python3
"""Import actual OSM hiking route relations through Waymarked Trails.

The API exposes an OSM-derived database, not an independent source of field
verification. Bounded geographic queries and two concurrent detail requests.
No geometry is invented; original way segments stay separate.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import threading
import urllib.parse
import urllib.request
from shapely.geometry import shape, box, MultiLineString
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/catalog'
RAW = OUT / 'raw/waymarked'
BASE = 'https://hiking.waymarkedtrails.org/api/v1'
UA = 'Tropa-data-import/0.1 (Russia hiking catalog; https://tropa-rf-atlas-2026.wintrybluebell1.chatgpt.site)'
R = 6378137.0
MAX_DETAILS = 600
MAX_LIST_QUERIES = 36
MAX_BODY = 12_000_000
LOCK = threading.Lock()
records, errors = [], []
EXCLUSION_FILE = OUT / 'geographic-exclusions.json'
SOURCE_EXCLUSIONS = {row['osmRelationId']: row for row in
    (json.loads(EXCLUSION_FILE.read_text()).get('records', []) if EXCLUSION_FILE.exists() else [])}


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not isinstance(data, bytes):
        data = (json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    temp = path.with_name(path.name + '.part')
    temp.write_bytes(data)
    temp.replace(path)


def fetch_json(url, relative):
    path = RAW / relative
    meta_path = path.with_suffix(path.suffix + '.source.json')
    if path.exists() and meta_path.exists():
        data = path.read_bytes()
        meta = json.loads(meta_path.read_text())
        if digest(data) != meta['sha256']:
            raise RuntimeError('Cached source checksum mismatch: ' + relative)
    else:
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Encoding': 'identity'})
        with urllib.request.urlopen(req, timeout=35) as response:
            data = response.read(MAX_BODY + 1)
            if len(data) > MAX_BODY:
                raise RuntimeError('API response exceeded explicit 12 MB bound')
            meta = {'sourceUrl': url, 'retrievedAt': now(), 'sha256': digest(data),
                    'bytes': len(data), 'etag': response.headers.get('ETag'),
                    'lastModified': response.headers.get('Last-Modified'),
                    'license': 'ODbL-1.0', 'attribution': '© OpenStreetMap contributors'}
        json.loads(data)
        save(path, data)
        save(meta_path, meta)
    with LOCK:
        records.append({'path': str(path.relative_to(OUT)), **meta})
    return json.loads(data), meta


def merc(lon, lat):
    return [math.radians(lon) * R, math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R]


def wgs(x, y):
    return [round(math.degrees(x / R), 7), round(math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2), 7)]


def length_km(lines):
    total = 0
    for line in lines:
        for a, b in zip(line, line[1:]):
            l1, l2 = math.radians(a[1]), math.radians(b[1])
            h = math.sin((l2-l1)/2)**2 + math.cos(l1)*math.cos(l2)*math.sin(math.radians(b[0]-a[0])/2)**2
            total += 6371.0088 * 2 * math.asin(min(1, math.sqrt(h)))
    return round(total, 3)


def segments(node, result, seen):
    if isinstance(node, dict):
        geometry = node.get('geometry')
        if node.get('route_type') == 'base' and geometry and geometry.get('type') == 'LineString':
            coords = geometry['coordinates']
            key = (node.get('id'), json.dumps(coords, separators=(',', ':')))
            if key not in seen and len(coords) >= 2:
                seen.add(key)
                result.append({'wayId': node.get('id'), 'osmTags': node.get('tags', {}),
                               'role': node.get('role'), 'coordinates': [wgs(*p[:2]) for p in coords]})
        for key, value in node.items():
            if key != 'geometry' and isinstance(value, (dict, list)):
                segments(value, result, seen)
    elif isinstance(node, list):
        for value in node:
            segments(value, result, seen)


def region_shapes():
    boundaries_path = ROOT / 'web/public/data/regions.geojson'
    boundaries = json.loads(boundaries_path.read_text())
    definitions = [
        ('altai', 'Алтай', ['Altai Krai', 'Altai Republic'], None),
        ('krasnodar', 'Краснодарский край', ['Krasnodar Krai'], None),
        ('karelia', 'Карелия', ['Republic of Karelia'], None),
        ('krym', 'Крым', [], [32.4, 44.3, 36.7, 46.2]),
        ('baikal', 'Байкал', ['Irkutsk Oblast', 'Buryatia'], [103.0, 51.1, 110.6, 56.4]),
        ('kamchatka', 'Камчатка', ['Kamchatka Krai'], None),
    ]
    result = {}
    for rid, name, names, extent in definitions:
        selected = [shape(f['geometry']) for f in boundaries['features'] if f['properties'].get('shapeName') in names]
        geometry = unary_union(selected) if selected else box(*extent)
        if extent and selected:
            geometry = geometry.intersection(box(*extent))
        if geometry.is_empty:
            raise RuntimeError('Empty destination boundary for ' + rid)
        result[rid] = {'name': name, 'shape': geometry, 'bbox': list(geometry.bounds),
                       'shapeNames': names, 'extentConstraint': extent,
                       'scope': 'tourism destination; geometry intersection, not an assertion of jurisdiction'}
    provenance = {'path': str(boundaries_path.relative_to(ROOT)),
                  'sha256': digest(boundaries_path.read_bytes()),
                  'usage': 'Existing project boundary geometries used only as a geographic inclusion filter.'}
    metadata_path = ROOT / 'web/public/data/boundaries-source.json'
    if metadata_path.exists():
        metadata = json.loads(metadata_path.read_text())
        provenance.update({key: metadata.get(key) for key in (
            'boundaryYearRepresented', 'boundarySource', 'boundaryLicense',
            'boundarySourceURL', 'gjDownloadURL', 'buildDate')})
    return result, provenance


def discover(regions):
    candidates = {}
    region_stats = {}
    query_count = 0
    for rid, region in regions.items():
        pending = [(region['bbox'], 0)]
        queries = []
        discovered = set()
        while pending and query_count < MAX_LIST_QUERIES:
            extent, depth = pending.pop(0)
            if not region['shape'].intersects(box(*extent)):
                continue
            query_count += 1
            xy = merc(extent[0], extent[1]) + merc(extent[2], extent[3])
            url = BASE + '/list/by_area?' + urllib.parse.urlencode({'bbox': ','.join(map(str, xy)), 'limit': 100})
            key = digest(json.dumps(extent).encode())[:12]
            try:
                data, meta = fetch_json(url, f'lists/{rid}-{depth}-{key}.json')
                values = data.get('results', [])
            except Exception as error:
                errors.append({'phase': 'list', 'regionId': rid, 'bbox': extent, 'error': str(error)})
                continue
            cap = len(values) >= 100
            queries.append({'bbox': extent, 'depth': depth, 'returned': len(values),
                            'atApiLimit': cap, 'sourceUrl': url, 'sha256': meta['sha256']})
            for item in values:
                if item.get('type') != 'relation':
                    continue
                ident = int(item['id'])
                discovered.add(ident)
                entry = candidates.setdefault(ident, {'item': item, 'discoveredIn': set()})
                entry['discoveredIn'].add(rid)
            # A count of 100 is ambiguous, so subdivide only the saturated area.
            # The bounded depth/overall limit is reported; completeness is never assumed.
            if cap and depth < 2:
                w, s, e, n = extent
                mx, my = (w + e) / 2, (s + n) / 2
                pending.extend([(b, depth + 1) for b in ([w,s,mx,my], [mx,s,e,my], [w,my,mx,n], [mx,my,e,n])])
        region_stats[rid] = {'name': region['name'], 'bbox': region['bbox'],
                             'shapeNames': region['shapeNames'], 'extentConstraint': region['extentConstraint'],
                             'discoveredRelationCount': len(discovered), 'queries': queries,
                             'unqueriedSubareas': len(pending),
                             'coverageStatus': 'bounded_snapshot_not_exhaustive',
                             'rawWayCoverage': 'separate Crimea extract only' if rid == 'krym' else 'not_imported'}
        print(json.dumps({'region': rid, 'discoveredRelations': len(discovered), 'listQueries': len(queries)}, ensure_ascii=False), flush=True)
    # Prefer Russian names for the bounded queue; geographic filtering after fetch
    # still decides membership. Name never establishes jurisdiction or validity.
    ordered = sorted(candidates, key=lambda ident: (not any('\u0400' <= c <= '\u04ff' for c in candidates[ident]['item'].get('name', '')), ident))
    selected = ordered[:MAX_DETAILS]
    return candidates, selected, region_stats


def get_detail(ident):
    return ident, *fetch_json(BASE + f'/details/relation/{ident}', f'relations/{ident}.json')


def normalize(ident, data, meta, regions):
    if ident in SOURCE_EXCLUSIONS:
        return None, 'primary_source_places_route_outside_selected_destinations'
    items = []
    segments(data.get('route'), items, set())
    if not items:
        return None, 'no_real_way_geometry'
    lines = [item['coordinates'] for item in items]
    geom = MultiLineString(lines)
    memberships = [rid for rid, region in regions.items() if geom.intersects(region['shape'])]
    if not memberships:
        return None, 'outside_destination_filter'
    tags = data.get('tags', {})
    if tags.get('route') not in ('hiking', 'foot', 'walking'):
        return None, 'route_type_not_hiking_foot_or_walking'
    title = tags.get('name:ru') or tags.get('name') or data.get('name') or f'Маршрут OSM {ident}'
    properties = {
        'id': f'osm-relation-{ident}', 'sourceType': 'route',
        'osmType': 'relation', 'osmId': ident, 'title': title, 'name': title,
        'ref': tags.get('ref'), 'routeType': tags.get('route'), 'regionIds': memberships,
        'sourceName': 'OpenStreetMap via Waymarked Trails',
        'sourceUrl': f'https://www.openstreetmap.org/relation/{ident}',
        'dataUrl': meta['sourceUrl'], 'sourceRawSha256': meta['sha256'],
        'retrievedAt': meta['retrievedAt'], 'upstreamDataTimestamp': None,
        'license': 'ODbL-1.0', 'licenseUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
        'attribution': '© OpenStreetMap contributors',
        'osmTags': tags, 'sourceWebsite': tags.get('website') or data.get('url'),
        'sourceOperator': tags.get('operator') or data.get('operator'),
        'sourceDifficultyTags': {k: tags[k] for k in ('sac_scale', 'trail_visibility', 'difficulty') if k in tags},
        'waymarkedLinear': data.get('linear'), 'segmentCount': len(items),
        'pointCount': sum(len(line) for line in lines), 'osmWayIds': [item['wayId'] for item in items],
        'geometryLengthKm': length_km(lines), 'officialDistanceKm': None,
        'duration': None, 'difficulty': None, 'conditions': None,
        'conditionsStatus': 'requires_current_verification', 'conditionsVerifiedAt': None,
        'elevationGainM': None, 'legalDifficultyCategory': None,
        'navigationReady': False, 'fieldVerified': False, 'accessPermissionVerified': False,
        'verificationStatus': 'source_only', 'publicationStatus': 'reference', 'indexable': False,
        'ratings': None, 'reviewsCount': 0, 'activeTrips': 0,
        'bbox': list(geom.bounds),
        'geometryNote': 'Real OSM way segments. Segment sum is not a verified itinerary distance; branches and gaps may exist. No synthetic connections or height profile.',
    }
    feature = {'type': 'Feature', 'id': properties['id'], 'properties': properties,
               'geometry': {'type': 'MultiLineString', 'coordinates': lines}}
    return feature, None


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    regions, boundary_source = region_shapes()
    candidates, selected, stats = discover(regions)
    features, rejected = [], []
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(get_detail, ident): ident for ident in selected}
        for future in as_completed(futures):
            ident = futures[future]
            try:
                _, data, meta = future.result()
                feature, reason = normalize(ident, data, meta, regions)
                if feature:
                    features.append(feature)
                else:
                    rejected.append({'osmRelationId': ident, 'reason': reason})
            except Exception as error:
                errors.append({'phase': 'detail_or_normalize', 'osmRelationId': ident, 'error': str(error)})
            done = len(features) + len(rejected) + sum(e['phase'] == 'detail_or_normalize' for e in errors)
            if done % 25 == 0:
                print(json.dumps({'detailsProcessed': done, 'accepted': len(features), 'rejected': len(rejected), 'errors': len(errors)}), flush=True)
    features.sort(key=lambda f: f['properties']['osmId'])
    expected_geometry_names = {feature['properties']['id'] + '.geojson' for feature in features}
    for old_geometry in (OUT / 'geometry').glob('osm-relation-*.geojson'):
        if old_geometry.name not in expected_geometry_names:
            old_geometry.unlink()
    output = OUT / 'routes.geojson'
    save(output, {'type': 'FeatureCollection', 'name': 'Source-only OSM hiking route catalog',
                  'license': 'ODbL-1.0', 'attribution': '© OpenStreetMap contributors', 'features': features})
    cards = []
    for feature in features:
        p = dict(feature['properties'])
        # Individual route files let the client request one real geometry at a time.
        relative = 'geometry/' + p['id'] + '.geojson'
        save(OUT / relative, {'type': 'FeatureCollection', 'features': [feature]})
        p['geometryPath'] = relative
        cards.append(p)
    save(OUT / 'routes.json', {'schemaVersion': 1, 'createdAt': now(), 'routes': cards})
    for rid, stat in stats.items():
        regional = [f for f in features if rid in f['properties']['regionIds']]
        stat['importedRouteCount'] = len(regional)
        stat['osmRelationIds'] = [f['properties']['osmId'] for f in regional]
        save(OUT / f'regions/{rid}.geojson', {'type': 'FeatureCollection', 'features': regional})
    report = {
        'createdAt': now(), 'source': 'OpenStreetMap via Waymarked Trails hiking API',
        'sourceType': 'OSM-derived route-relation database, not independently field-verified routes',
        'license': 'ODbL-1.0', 'licenseUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
        'attribution': '© OpenStreetMap contributors',
        'apiSource': 'https://github.com/waymarkedtrails/waymarkedtrails-api',
        'candidateCount': len(candidates), 'detailRequestsPlanned': len(selected),
        'detailsExcludedByGlobalBound': len(candidates) - len(selected),
        'routeCount': len(features), 'verifiedRouteCount': 0,
        'regionCountsOverlap': 'A route crossing destination boundaries may occur in multiple regional counts; global routeCount is deduplicated by OSM relation id.',
        'regions': stats, 'boundaryFilterSource': boundary_source,
        'limits': {'maxConcurrentDetailRequests': 2, 'maxDetails': MAX_DETAILS,
                   'maxListQueries': MAX_LIST_QUERIES, 'maxResponseBytes': MAX_BODY,
                   'apiListLimit': 100, 'subdivisionDepth': 2},
        'conversion': 'Waymarked EPSG:3857 way segments reprojected to WGS84 and rounded to 7 decimals; no simplification, stitching, gap filling or generated geometry.',
        'geometryLengthMeaning': 'Sum of distinct preserved segments, including branches; not official route distance or recommended itinerary length.',
        'rejected': rejected, 'errors': errors,
        'sourceBackedGeographicExclusions': list(SOURCE_EXCLUSIONS.values()),
        'rawSources': records,
        'outputs': [{'path': str(output.relative_to(OUT)), 'bytes': output.stat().st_size, 'sha256': digest(output.read_bytes())}],
        'limitations': [
            'Finite bounding-box snapshot with API and request caps; no claim of exhaustive trail coverage.',
            'Geographic inclusion is intersection with the existing project destination geometry. Whole original relations can extend beyond a destination.',
            'A route relation can be branched, disconnected, outdated or mapped incompletely.',
            'Difficulty, current access, closures, permits and guide qualification are not established by this import.',
            'Public profile, booking, chat and verified-rating data are not supplied by these map databases.',
        ],
    }
    save(OUT / 'waymarked-import-report.json', report)
    print(json.dumps({'routeCount': len(features), 'regions': {k:v['importedRouteCount'] for k,v in stats.items()},
                      'rejected': len(rejected), 'errors': errors}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
