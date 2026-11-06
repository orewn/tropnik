#!/usr/bin/env python3
"""Import actual OSM foot-path ways from a small Geofabrik regional PBF.

These are raw map segments, not verified trips or permission to hike.
Requires osmium==4.3.2; optional local dependencies live in _deps/.
"""
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sys
import urllib.request

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / '_deps'))
import osmium

ROOT = HERE.parents[1]
OUT = ROOT / 'data/catalog'
RAW = OUT / 'raw/geofabrik'
URL = 'https://download.geofabrik.de/russia/crimean-fed-district-latest.osm.pbf'
SOURCE_PAGE = 'https://download.geofabrik.de/russia/crimean-fed-district.html'
UA = 'Tropa-data-import/0.1 (Russia hiking catalog; https://tropa-rf-atlas-2026.wintrybluebell1.chatgpt.site)'
LIMIT = 100_000_000


def now():
    return datetime.now(timezone.utc).isoformat()


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')


def download():
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / 'crimean-fed-district-latest.osm.pbf'
    metadata_path = RAW / 'source.json'
    if path.exists() and metadata_path.exists():
        metadata = json.loads(metadata_path.read_text())
        if hashlib.sha256(path.read_bytes()).hexdigest() != metadata['sha256']:
            raise RuntimeError('Existing PBF checksum mismatch')
        return path, metadata
    req = urllib.request.Request(URL, headers={'User-Agent': UA, 'Accept-Encoding': 'identity'})
    temp = path.with_suffix('.pbf.part')
    with urllib.request.urlopen(req, timeout=45) as response:
        size = int(response.headers.get('Content-Length', 0))
        if size > LIMIT:
            raise RuntimeError('Regional PBF exceeds explicit 100 MB import budget')
        digest, total = hashlib.sha256(), 0
        with temp.open('wb') as out:
            while True:
                chunk = response.read(min(1024 * 1024, LIMIT - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > LIMIT:
                    raise RuntimeError('Regional PBF exceeded download budget')
                digest.update(chunk)
                out.write(chunk)
        metadata = {
            'sourceUrl': URL, 'sourcePage': SOURCE_PAGE,
            'downloadedAt': now(), 'bytes': total, 'sha256': digest.hexdigest(),
            'lastModified': response.headers.get('Last-Modified'),
            'etag': response.headers.get('ETag'), 'license': 'ODbL-1.0',
            'licenseUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
            'attribution': '© OpenStreetMap contributors; extract by Geofabrik',
            'downloadLimitBytes': LIMIT,
            'sourceRegionLabel': 'Crimean Federal District (Geofabrik dataset name)',
            'boundaryNote': 'Source download naming is preserved as provenance, not an application assertion about sovereignty. Geofabrik includes Crimea in both Russia and Ukraine extracts.',
        }
    temp.replace(path)
    save_json(metadata_path, metadata)
    return path, metadata


def length_km(coords):
    total = 0.0
    for a, b in zip(coords, coords[1:]):
        lat1, lat2 = math.radians(a[1]), math.radians(b[1])
        dlat, dlon = lat2 - lat1, math.radians(b[0] - a[0])
        h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
        total += 6371.0088 * 2 * math.asin(min(1, math.sqrt(h)))
    return round(total, 4)


class Trails(osmium.SimpleHandler):
    def __init__(self, source):
        super().__init__()
        self.source = source
        self.features = []
        self.seen_ways = 0
        self.invalid_geometry = []
        self.skipped_sidewalks = 0
        self.by_highway = {}
        self.relation_count = 0

    def way(self, way):
        self.seen_ways += 1
        tags = dict(way.tags)
        highway = tags.get('highway')
        if highway not in ('path', 'footway', 'bridleway'):
            return
        if tags.get('footway') in ('sidewalk', 'crossing', 'traffic_island', 'link'):
            self.skipped_sidewalks += 1
            return
        try:
            coords = [[round(n.lon, 7), round(n.lat, 7)] for n in way.nodes]
        except osmium.InvalidLocationError:
            self.invalid_geometry.append(way.id)
            return
        if len(coords) < 2:
            self.invalid_geometry.append(way.id)
            return
        self.by_highway[highway] = self.by_highway.get(highway, 0) + 1
        properties = {
            'id': f'osm-way-{way.id}', 'sourceType': 'raw_trail',
            'osmType': 'way', 'osmId': way.id, 'osmVersion': way.version,
            'osmTimestamp': way.timestamp.isoformat(),
            'name': tags.get('name:ru') or tags.get('name'),
            'regionIds': ['krym'], 'highway': highway, 'osmTags': tags,
            'sourceUrl': f'https://www.openstreetmap.org/way/{way.id}',
            'datasetUrl': URL, 'sourceDatasetSha256': self.source['sha256'],
            'retrievedAt': self.source['downloadedAt'],
            'license': 'ODbL-1.0', 'attribution': '© OpenStreetMap contributors',
            'geometryLengthKm': length_km(coords),
            'officialDistanceKm': None, 'difficulty': None, 'conditions': None,
            'legalDifficultyCategory': None, 'elevationGainM': None,
            'navigationReady': False, 'fieldVerified': False,
            'verificationStatus': 'source_only', 'publicationStatus': 'reference',
            'accessPermissionVerified': False,
            'sourceAccessRestriction': tags.get('access'),
            'sourceFootRestriction': tags.get('foot'),
            'geometryNote': 'An original OSM way segment. It may be an urban footpath, may have restrictions, and is not a complete or verified hiking route.',
        }
        self.features.append({'type': 'Feature', 'id': properties['id'], 'properties': properties,
                              'geometry': {'type': 'LineString', 'coordinates': coords}})

    def relation(self, relation):
        tags = dict(relation.tags)
        if tags.get('type') == 'route' and tags.get('route') in ('hiking', 'foot', 'walking'):
            self.relation_count += 1


def main():
    path, source = download()
    print(json.dumps({'downloaded': str(path), 'bytes': source['bytes'], 'sha256': source['sha256']}), flush=True)
    with osmium.io.Reader(str(path)) as reader:
        header = reader.header()
        source['osmReplicationTimestamp'] = header.get('osmosis_replication_timestamp') or None
        source['osmReplicationSequence'] = header.get('osmosis_replication_sequence_number') or None
        source['generator'] = header.get('generator') or None
    save_json(RAW / 'source.json', source)
    handler = Trails(source)
    handler.apply_file(str(path), locations=True, idx='flex_mem')
    handler.features.sort(key=lambda x: x['properties']['osmId'])
    output = OUT / 'raw-trails-krym.geojson'
    save_json(output, {'type': 'FeatureCollection', 'name': 'Unverified OSM foot-path segments, Crimea extract',
                      'license': 'ODbL-1.0', 'attribution': '© OpenStreetMap contributors',
                      'features': handler.features})
    report = {
        'createdAt': now(), 'source': source, 'rawTrailCount': len(handler.features),
        'byHighway': handler.by_highway, 'waysExamined': handler.seen_ways,
        'excludedExplicitSidewalkOrCrossingWays': handler.skipped_sidewalks,
        'invalidGeometryWayIds': handler.invalid_geometry,
        'hikingFootWalkingRelationsInSource': handler.relation_count,
        'outputPath': str(output.relative_to(OUT)), 'outputBytes': output.stat().st_size,
        'outputSha256': hashlib.sha256(output.read_bytes()).hexdigest(),
        'filter': {'highway': ['path', 'footway', 'bridleway'],
                   'excludeFootway': ['sidewalk', 'crossing', 'traffic_island', 'link']},
        'coverage': 'All matching ways present in this downloaded regional extract; not all physical trails and not all hiking routes. No field validation.',
        'geographicScope': 'Geofabrik Crimea extract. Other five destinations are covered separately through route relations, not this raw-way dataset.',
        'coordinateChanges': 'Only rounding to 7 decimal places; no new geometry, gap joining or simplification.',
    }
    save_json(OUT / 'geofabrik-import-report.json', report)
    print(json.dumps({k: report[k] for k in ('rawTrailCount', 'byHighway', 'waysExamined', 'invalidGeometryWayIds', 'outputBytes')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
