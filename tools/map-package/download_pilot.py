#!/usr/bin/env python3
"""Download one bounded, attributed OpenFreeMap pilot; stdlib only.

The provider's policy was checked on 2026-11-06:
https://openfreemap.org/quick_start/ and https://openfreemap.org/tos/
No bulk region downloader, proxy rotation, authentication bypass or retry loop.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
import math
from pathlib import Path
import threading
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/pilot-map'
BBOX = [40.29, 43.64, 40.49, 43.82]
MINZOOM, MAXZOOM = 7, 14
TILEJSON_URL = 'https://tiles.openfreemap.org/planet/latest'
TILE_TEMPLATE = 'https://tiles.openfreemap.org/planet/20261101_080013_pt/{z}/{x}/{y}.pbf'
FONTSTACK = 'Noto Sans Regular'
GLYPH_RANGES = ['0-255', '1024-1279', '8192-8447', '9472-9727']
USER_AGENT = 'Tropa-development/0.1 (bounded offline map pilot; https://tropa-rf-atlas-2026.wintrybluebell1.chatgpt.site)'
MAX_TILES, MAX_PARALLEL = 3000, 4
# Leave one MB for the manifest, provenance and notices. Both transferred
# response bodies and locally uncompressed resources must fit this bound.
BODY_LIMIT, PACK_LIMIT = 49_000_000, 50_000_000
LOCK = threading.Lock()
STOP = threading.Event()
COUNTERS = {'wireBytes': 0, 'reservedBytes': 0, 'storedBytes': 0, 'requests': 0}


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_file(relative, body):
    dest = OUT / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    with LOCK:
        old = dest.stat().st_size if dest.exists() else 0
        if COUNTERS['storedBytes'] + len(body) - old > BODY_LIMIT:
            STOP.set()
            raise RuntimeError('Uncompressed package budget exhausted')
        COUNTERS['storedBytes'] += len(body) - old
    temp = dest.with_name(dest.name + '.part')
    temp.write_bytes(body)
    temp.replace(dest)
    return {'path': relative, 'bytes': len(body), 'sha256': sha(body)}


def fetch(url):
    if STOP.is_set():
        raise RuntimeError('Download stopped after another resource failed')
    req = urllib.request.Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'identity',
        'Accept': '*/*',
    })
    with LOCK:
        COUNTERS['requests'] += 1
    with urllib.request.urlopen(req, timeout=35) as response:
        if urllib.parse.urlparse(response.url).hostname != urllib.parse.urlparse(url).hostname:
            raise RuntimeError('Unexpected cross-host redirect')
        data = bytearray()
        while True:
            with LOCK:
                remaining = BODY_LIMIT - COUNTERS['wireBytes'] - COUNTERS['reservedBytes']
                allowance = min(65536, remaining)
                if allowance <= 0:
                    STOP.set()
                    raise RuntimeError('Transfer budget exhausted')
                COUNTERS['reservedBytes'] += allowance
            try:
                chunk = response.read(allowance)
            except BaseException:
                with LOCK:
                    COUNTERS['reservedBytes'] -= allowance
                raise
            with LOCK:
                COUNTERS['reservedBytes'] -= allowance
                COUNTERS['wireBytes'] += len(chunk)
            if not chunk:
                break
            data.extend(chunk)
        raw = bytes(data)
        meta = {
            'sourceUrl': url,
            'retrievedAt': now(),
            'wireBytes': len(raw),
            'wireSha256': sha(raw),
            'responseContentType': response.headers.get('Content-Type'),
            'responseContentEncoding': response.headers.get('Content-Encoding'),
            'etag': response.headers.get('ETag'),
            'lastModified': response.headers.get('Last-Modified'),
        }
    if raw.startswith(b'\x1f\x8b'):
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as gz:
            body = gz.read(BODY_LIMIT + 1)
        if len(body) > BODY_LIMIT:
            raise RuntimeError('Unexpectedly large decompressed resource')
        meta['storageTransform'] = 'gzip decompressed; protobuf content unchanged'
    else:
        body = raw
        meta['storageTransform'] = 'none'
    return body, meta


def varint(data, offset):
    result, shift = 0, 0
    while offset < len(data) and shift < 70:
        b = data[offset]
        offset += 1
        result |= (b & 127) << shift
        if b < 128:
            return result, offset
        shift += 7
    raise ValueError('Invalid protobuf varint')


def fields(data):
    offset = 0
    while offset < len(data):
        tag, offset = varint(data, offset)
        number, kind = tag >> 3, tag & 7
        if not number:
            raise ValueError('Invalid protobuf field number')
        if kind == 0:
            value, offset = varint(data, offset)
        elif kind in (1, 5):
            size = 8 if kind == 1 else 4
            value = data[offset:offset + size]
            offset += size
        elif kind == 2:
            size, offset = varint(data, offset)
            value = data[offset:offset + size]
            offset += size
        else:
            raise ValueError('Unsupported protobuf wire type')
        if offset > len(data):
            raise ValueError('Truncated protobuf message')
        yield number, kind, value


def validate_pbf(body, kind):
    top = list(fields(body))
    if kind == 'tile':
        layers = []
        for number, wire, value in top:
            if number != 3 or wire != 2:
                raise ValueError('Not an MVT tile')
            parts = list(fields(value))
            name = next((v.decode('utf-8') for n, w, v in parts if n == 1 and w == 2), None)
            if name is None:
                raise ValueError('MVT layer without name')
            layers.append(name)
        return {'mvtLayers': layers}
    if not top or any(n != 1 or w != 2 for n, w, _ in top):
        raise ValueError('Not a glyph protobuf')
    stacks = []
    for _, _, value in top:
        parts = list(fields(value))
        stacks.append({
            'name': next((v.decode('utf-8') for n, w, v in parts if n == 1 and w == 2), None),
            'range': next((v.decode('utf-8') for n, w, v in parts if n == 2 and w == 2), None),
            'glyphCount': sum(n == 3 and w == 2 for n, w, _ in parts),
        })
    return {'glyphStacks': stacks}


def tile_coordinates():
    west, south, east, north = BBOX
    for z in range(MINZOOM, MAXZOOM + 1):
        n = 2 ** z
        x0, x1 = [int((v + 180) / 360 * n) for v in (west, east)]
        y0, y1 = [int((1 - math.asinh(math.tan(math.radians(v))) / math.pi) / 2 * n) for v in (north, south)]
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                yield z, x, y


def resource(job):
    relative, url, kind = job
    body, meta = fetch(url)
    validation = validate_pbf(body, kind) if kind in ('tile', 'glyph') else {}
    record = write_file(relative, body)
    record.update(meta)
    record.update(validation)
    record['kind'] = kind
    return record


def main():
    coords = list(tile_coordinates())
    if len(coords) > MAX_TILES:
        raise RuntimeError('Tile count exceeds provider policy')
    OUT.mkdir(parents=True, exist_ok=True)
    existing = list(OUT.rglob('*'))
    if any(p.is_file() for p in existing):
        raise RuntimeError('Refusing to overwrite an existing package; inspect it first')
    started = now()
    records, failures = [], []
    metadata, meta = fetch(TILEJSON_URL)
    tilejson = json.loads(metadata)
    if TILE_TEMPLATE not in tilejson['tiles']:
        raise RuntimeError('Planet snapshot changed; inspect and repin before downloading')
    record = write_file('source-tilejson.json', metadata)
    record.update(meta)
    record['kind'] = 'metadata'
    records.append(record)
    jobs = []
    for block in GLYPH_RANGES:
        relative = f'fonts/{FONTSTACK}/{block}.pbf'
        url = 'https://tiles.openfreemap.org/' + urllib.parse.quote(relative, safe='/')
        jobs.append((relative, url, 'glyph'))
    for z, x, y in coords:
        jobs.append((f'localtiles/{z}/{x}/{y}.pbf', TILE_TEMPLATE.format(z=z, x=x, y=y), 'tile'))
    print(json.dumps({'plannedTiles': len(coords), 'plannedGlyphRanges': len(GLYPH_RANGES), 'bbox': BBOX}), flush=True)
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL) as pool:
        futures = {pool.submit(resource, job): job for job in jobs}
        for future in as_completed(futures):
            job = futures[future]
            try:
                records.append(future.result())
                if len(records) % 25 == 0:
                    print(json.dumps({'resourcesComplete': len(records), **COUNTERS}), flush=True)
            except Exception as error:
                failures.append({'path': job[0], 'sourceUrl': job[1], 'error': str(error)})
                if not (job[2] == 'glyph' and isinstance(error, urllib.error.HTTPError) and error.code == 404):
                    STOP.set()
                print(json.dumps({'failed': job[0], 'error': str(error)}), flush=True)
    route = (ROOT / 'data/route-11566519.geojson').read_bytes()
    record = write_file('route-11566519.geojson', route)
    record['kind'] = 'route-geometry'
    record['sourceUrl'] = 'https://www.openstreetmap.org/relation/11566519'
    records.append(record)
    # Primary licence notices, fetched directly without changing identity.
    license_jobs = [
        ('licenses/Noto-Sans-OFL-1.1.txt', 'https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/main/OFL.txt', 'license'),
        ('licenses/OpenMapTiles-LICENSE.md', 'https://raw.githubusercontent.com/openmaptiles/openmaptiles/master/LICENSE.md', 'license'),
        ('licenses/OpenFreeMap-LICENSE.md', 'https://raw.githubusercontent.com/hyperknot/openfreemap/main/LICENSE.md', 'license'),
    ]
    if not STOP.is_set():
        for job in license_jobs:
            try:
                records.append(resource(job))
            except Exception as error:
                failures.append({'path': job[0], 'sourceUrl': job[1], 'error': str(error)})
    manifest = {
        'schemaVersion': 1,
        'id': 'bzerpinskiy-pilot-20261101-z7-z14',
        'title': 'Офлайн-карта района Бзерпинского карниза',
        'createdAt': now(), 'downloadStartedAt': started,
        'bbox': BBOX, 'bboxCrs': 'EPSG:4326', 'tileMatrix': 'XYZ Web Mercator',
        'minzoom': MINZOOM, 'maxzoom': MAXZOOM,
        'tileCountExpected': len(coords),
        'tileCount': sum(r['kind'] == 'tile' for r in records),
        'glyphRangesExpected': GLYPH_RANGES,
        'fontstack': FONTSTACK,
        'source': {'provider': 'OpenFreeMap', 'tilejsonUrl': TILEJSON_URL,
                   'pinnedTileTemplate': TILE_TEMPLATE, 'schema': 'OpenMapTiles',
                   'schemaVersionReported': tilejson.get('version'),
                   'sourceSnapshotId': '20261101_080013_pt',
                   'sourceSnapshotDateInIdentifier': '2026-11-01',
                   'osmDataTimestamp': None},
        'localTiles': 'localtiles/{z}/{x}/{y}.pbf',
        'localGlyphs': 'fonts/{fontstack}/{range}.pbf',
        'storedPbfEncoding': 'identity',
        'policy': {'checkedAt': '2026-11-06', 'url': 'https://openfreemap.org/quick_start/',
                   'termsUrl': 'https://openfreemap.org/tos/', 'termsUpdated': '2026-10-14',
                   'maxTiles': MAX_TILES, 'maxBytes': PACK_LIMIT, 'maxParallel': MAX_PARALLEL,
                   'userAgent': USER_AGENT, 'hardTransferLimitBytes': BODY_LIMIT,
                   'downloadedResponseBodyBytes': COUNTERS['wireBytes'],
                   'requests': COUNTERS['requests'], 'usedProxiesOrIdentityRotation': False},
        'attributionText': 'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors',
        'attributionHtml': tilejson.get('attribution'),
        'ipRights': [
            {'component': 'OpenStreetMap map data and route geometry', 'license': 'ODbL-1.0',
             'source': 'https://www.openstreetmap.org/copyright',
             'licenseUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
             'attribution': '© OpenStreetMap contributors'},
            {'component': 'OpenMapTiles schema design', 'license': 'CC-BY-4.0',
             'source': 'https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md',
             'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
             'attribution': '© OpenMapTiles', 'noticePath': 'licenses/OpenMapTiles-LICENSE.md'},
            {'component': 'Noto Sans Regular glyphs', 'license': 'OFL-1.1',
             'source': 'https://github.com/hyperknot/openfreemap/blob/main/LICENSE.md',
             'fontSource': 'https://github.com/notofonts/latin-greek-cyrillic',
             'noticePath': 'licenses/Noto-Sans-OFL-1.1.txt'},
            {'component': 'Natural Earth source data, where present upstream', 'license': 'Public domain',
             'source': 'https://github.com/hyperknot/openfreemap/blob/main/LICENSE.md'},
        ],
        'limitations': [
            'Covers only the stated bounding box, not Russia or all of the Caucasus.',
            'Tile cells extend beyond the requested bbox, especially at small zooms; clients should constrain the viewport.',
            'No satellite imagery, terrain DEM, hillshade, live closures, weather or emergency connectivity included.',
            'The real route relation contains branches and is not a verified navigation track.',
            'Snapshot date comes from the provider identifier; exact upstream OSM data age is not supplied.',
            'Pack contains no provider style or sprites. Use the separate original application style.',
            'Only the four specified glyph blocks are included; other writing systems may lack labels.',
        ],
        'failures': failures,
        'complete': not failures and sum(r['kind'] == 'tile' for r in records) == len(coords),
        'files': sorted(records, key=lambda r: r['path']),
        'resourceBytes': sum(r['bytes'] for r in records),
    }
    path = OUT / 'manifest.json'
    # Include manifest bytes in the final package total (self hash intentionally excluded).
    manifest['packageBytesIncludingManifest'] = 0
    for _ in range(4):
        encoded = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
        total = manifest['resourceBytes'] + len(encoded)
        if total == manifest['packageBytesIncludingManifest']:
            break
        manifest['packageBytesIncludingManifest'] = total
    path.write_bytes((json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode())
    if manifest['packageBytesIncludingManifest'] > PACK_LIMIT:
        raise RuntimeError('Final manifest exceeded package budget')
    print(json.dumps({k: manifest[k] for k in ('complete', 'tileCount', 'resourceBytes', 'packageBytesIncludingManifest', 'failures')}, ensure_ascii=False), flush=True)
    if not manifest['complete']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
