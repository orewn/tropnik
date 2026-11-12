#!/usr/bin/env python3
"""Extract bounded, measured terrain and land cover from original public COGs.

No rendered map service, OpenStreetMap data, generated heights or silent nodata
filling is used. A loopback range gateway records the exact downloaded bytes and
enforces a transfer budget before GDAL can read any remote raster blocks.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import re
import threading
import urllib.error
import urllib.request

import numpy as np
from PIL import Image
import rasterio
from rasterio.windows import Window, from_bounds


ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'web/public/terrain-regions'
USER_AGENT = 'Tropnik/terrain-data (bounded public COG extraction)'
DEM_INDEX = 'https://copernicus-dem-30m.s3.amazonaws.com/tileList.txt'
COVER_INDEX = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v100/2020/esa_worldcover_2020_grid.geojson'
COP_LICENSE = 'https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf'
COP_ATTRIBUTION = ('produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and '
                   '© Airbus Defence and Space GmbH 2014-2018 provided under '
                   'COPERNICUS by the European Union and ESA; all rights reserved')
COP_LIABILITY = ('The organisations in charge of the Copernicus programme by law or '
                 'by delegation do not incur any liability for any use of the '
                 'Copernicus WorldDEM-30.')
COVER_ATTRIBUTION = ('© ESA WorldCover project 2021 / Contains modified Copernicus '
                     'Sentinel data (2021) processed by ESA WorldCover consortium')
MATERIAL_PALETTE_VERSION = 2
PALETTE = {
    10: ('tree-cover', (121, 151, 108, 255)),
    20: ('shrubland', (147, 166, 119, 255)),
    30: ('grassland', (181, 187, 142, 255)),
    40: ('cropland', (190, 190, 148, 255)),
    50: ('built-up', (190, 184, 169, 255)),
    60: ('bare-or-sparse-vegetation', (177, 174, 156, 255)),
    70: ('snow-and-ice', (233, 238, 229, 255)),
    80: ('permanent-water', (106, 157, 163, 255)),
    90: ('herbaceous-wetland', (149, 171, 146, 255)),
    95: ('mangroves', (103, 145, 130, 255)),
    100: ('moss-and-lichen', (168, 180, 147, 255)),
}


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded_json(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode()


def headers_record(headers):
    return {key.lower(): value for key, value in headers.items() if key.lower() in
            ('content-length', 'content-range', 'content-type', 'etag', 'last-modified', 'x-amz-version-id')}


def get_small(url, limit):
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=40) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError(f'Index exceeds {limit} bytes: {url}')
        return data, {'url': url, 'sha256': digest(data), 'downloadedBytes': len(data),
                      'retrievedAt': now(), 'httpHeaders': headers_record(response.headers)}


class RangeBudget:
    """Budget is shared across all source objects and checked before each read."""
    def __init__(self, limit):
        self.limit, self.used, self.requests = limit, 0, 0
        self.lock = threading.Lock()

    def reserve(self, size):
        with self.lock:
            if size < 0 or size > 8 * 1024 * 1024:
                raise ValueError('A source request exceeds the 8 MiB range limit')
            if self.used + size > self.limit or self.requests >= 192:
                raise ValueError('Bounded source transfer budget exhausted')
            self.used += size
            self.requests += 1


class CogSource:
    def __init__(self, url, dataset, budget, cache):
        self.url, self.dataset, self.budget = url, dataset, budget
        request = urllib.request.Request(url, method='HEAD', headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(request, timeout=40) as response:
            self.headers = headers_record(response.headers)
            self.size = int(response.headers.get('Content-Length', '0'))
        if not 0 < self.size <= 2 * 1024**3:
            raise ValueError(f'Unexpected source object size: {self.size}: {url}')
        self.etag = self.headers.get('etag')
        if not self.etag:
            raise ValueError(f'Source must expose a stable ETag: {url}')
        self.cache = cache / digest((url + self.etag).encode())
        self.cache.mkdir(parents=True, exist_ok=True)
        self.ranges, self.lock = {}, threading.Lock()
        self.opened_at = now()

    def read(self, start, end):
        if start < 0 or end < start or end >= self.size:
            raise ValueError(f'Invalid byte range {start}-{end}/{self.size}')
        with self.lock:
            # GDAL often repeats an initial block or asks for a subrange.
            for (lo, hi), record in self.ranges.items():
                if lo <= start and end <= hi:
                    data = Path(record['_cachePath']).read_bytes()
                    return data[start - lo:end - lo + 1]
            path = self.cache / f'{start}-{end}.bin'
            hash_path = path.with_suffix('.sha256')
            expected = end - start + 1
            self.budget.reserve(expected)
            cached = path.exists() and hash_path.exists() and path.stat().st_size == expected
            if cached:
                data = path.read_bytes()
                if digest(data) != hash_path.read_text().strip():
                    raise ValueError('Local source range cache hash mismatch; preserve it for inspection')
            else:
                request = urllib.request.Request(self.url, headers={
                    'User-Agent': USER_AGENT, 'Range': f'bytes={start}-{end}',
                    'If-Match': self.etag, 'Accept-Encoding': 'identity'})
                with urllib.request.urlopen(request, timeout=60) as response:
                    content_range = response.headers.get('Content-Range')
                    if response.status != 206 or content_range != f'bytes {start}-{end}/{self.size}':
                        raise ValueError(f'Server ignored exact bounded range: {response.status}: {content_range}')
                    if response.headers.get('ETag') != self.etag:
                        raise ValueError('Source object changed during extraction')
                    data = response.read(expected + 1)
                    if len(data) != expected:
                        raise ValueError(f'Incorrect source range length: {len(data)} != {expected}')
                path.write_bytes(data)
                hash_path.write_text(digest(data) + '\n')
            self.ranges[(start, end)] = {'start': start, 'endInclusive': end,
                'bytes': len(data), 'sha256': digest(data), 'fromVerifiedObjectCache': cached,
                '_cachePath': str(path)}
            return data

    def provenance(self):
        return {'dataset': self.dataset, 'url': self.url, 'retrievedAt': self.opened_at,
                'objectSizeBytes': self.size, 'httpHeaders': self.headers,
                'sourceObjectSha256': None,
                'hashScope': 'Individual exact HTTP byte ranges; full source object was not downloaded',
                'ranges': [{k: v for k, v in record.items() if not k.startswith('_')}
                           for _, record in sorted(self.ranges.items())],
                'readBytes': sum(r['bytes'] for r in self.ranges.values())}


class RangeGateway:
    def __init__(self, sources):
        self.sources = sources
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_args):
                pass

            def source(self):
                match = re.fullmatch(r'/(\d+)\.tif', self.path)
                if not match or int(match[1]) >= len(owner.sources):
                    return None
                return owner.sources[int(match[1])]

            def do_HEAD(self):
                source = self.source()
                if source is None:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'image/tiff')
                self.send_header('Content-Length', str(source.size))
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('ETag', source.etag)
                self.end_headers()

            def do_GET(self):
                source = self.source()
                match = re.fullmatch(r'bytes=(\d+)-(\d+)', self.headers.get('Range', ''))
                if source is None or not match:
                    self.send_error(400, 'Only bounded single-range TIFF reads are supported')
                    return
                try:
                    start, end = int(match[1]), min(int(match[2]), source.size - 1)
                    data = source.read(start, end)
                    self.send_response(206)
                    self.send_header('Content-Type', 'image/tiff')
                    self.send_header('Content-Length', str(len(data)))
                    self.send_header('Content-Range', f'bytes {start}-{end}/{source.size}')
                    self.send_header('Accept-Ranges', 'bytes')
                    self.send_header('ETag', source.etag)
                    self.end_headers()
                    self.wfile.write(data)
                except Exception as error:
                    owner.error = error
                    self.send_error(502, str(error))

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.error = None

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()

    def url(self, source):
        return f'http://127.0.0.1:{self.server.server_port}/{self.sources.index(source)}.tif'


def deg_name(latitude, longitude):
    return f'{"N" if latitude >= 0 else "S"}{abs(latitude):02d}_00_{"E" if longitude >= 0 else "W"}{abs(longitude):03d}_00'


def discover(bounds):
    dem_data, dem_record = get_small(DEM_INDEX, 2 * 1024**2)
    cover_data, cover_record = get_small(COVER_INDEX, 5 * 1024**2)
    dem_names = set(dem_data.decode().splitlines())
    cover_grid = json.loads(cover_data)
    cover_names = {f['properties']['ll_tile'] for f in cover_grid['features']}
    west, south, east, north = bounds
    # Two native DEM samples form a real interpolation halo across source edges.
    halo = 2 / 3600
    dem, cover = [], []
    for latitude in range(math.floor(south - halo), math.floor(north + halo) + 1):
        for longitude in range(math.floor(west - halo), math.floor(east + halo) + 1):
            stem = 'Copernicus_DSM_COG_10_' + deg_name(latitude, longitude) + '_DEM'
            if stem not in dem_names and stem + '/' not in dem_names:
                raise ValueError(f'GLO-30 tile absent in official mirror index: {stem}; no silent fallback')
            dem.append(f'https://copernicus-dem-30m.s3.amazonaws.com/{stem}/{stem}.tif')
    for latitude in range(3 * math.floor(south / 3), 3 * math.floor(north / 3) + 1, 3):
        for longitude in range(3 * math.floor(west / 3), 3 * math.floor(east / 3) + 1, 3):
            tile = f'{"N" if latitude >= 0 else "S"}{abs(latitude):02d}{"E" if longitude >= 0 else "W"}{abs(longitude):03d}'
            if tile not in cover_names:
                raise ValueError(f'WorldCover tile absent in published grid: {tile}')
            cover.append('https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/'
                         f'ESA_WorldCover_10m_2021_v200_{tile}_Map.tif')
    if len(dem) + len(cover) > 12:
        raise ValueError('Maximum 12 remote source assets per bounded extraction')
    return dem, cover, [dem_record, cover_record]


def native_window(dataset, bounds, padding):
    window = from_bounds(*bounds, transform=dataset.transform)
    col0 = max(0, math.floor(window.col_off) - padding)
    row0 = max(0, math.floor(window.row_off) - padding)
    col1 = min(dataset.width, math.ceil(window.col_off + window.width) + padding)
    row1 = min(dataset.height, math.ceil(window.row_off + window.height) + padding)
    if col1 <= col0 or row1 <= row0:
        return None
    return Window(col0, row0, col1 - col0, row1 - row0)


def read_crops(sources, gateway, bounds, padding):
    arrays, records = [], []
    for source in sources:
        with rasterio.open(gateway.url(source)) as dataset:
            if dataset.crs != rasterio.crs.CRS.from_epsg(4326) or dataset.count != 1:
                raise ValueError(f'Unexpected CRS/band count in original COG: {source.url}')
            window = native_window(dataset, bounds, padding)
            if window is None:
                continue
            if window.width * window.height > 12_000_000:
                raise ValueError('Native crop exceeds 12 million samples')
            values = dataset.read(1, window=window, masked=True)
            transform = dataset.window_transform(window)
            records.append({'url': source.url, 'sourceDimensions': [dataset.width, dataset.height],
                'sourceTransform': list(dataset.transform)[:6], 'crs': dataset.crs.to_string(),
                'sourceNodata': dataset.nodata, 'sourceDataType': dataset.dtypes[0],
                'window': [window.col_off, window.row_off, window.width, window.height],
                'windowTransform': list(transform)[:6], 'haloNativeSamples': padding,
                'nativeWindowSamplesSha256': digest(np.ascontiguousarray(values.data).tobytes()),
                'nativeWindowMaskSha256': digest(np.ascontiguousarray(np.ma.getmaskarray(values), dtype=np.uint8).tobytes())})
            arrays.append((values, transform))
    return arrays, records


def mosaic(crops):
    """Merge adjacent original grids without resampling their native samples."""
    dx, dy = crops[0][1].a, crops[0][1].e
    if any(abs(t.a - dx) > 1e-12 or abs(t.e - dy) > 1e-12 for _, t in crops):
        raise ValueError('Native source spacings differ; split bounds at latitude band before extraction')
    west = min(t.c for _, t in crops)
    north = max(t.f for _, t in crops)
    east = max(t.c + array.shape[1] * dx for array, t in crops)
    south = min(t.f + array.shape[0] * dy for array, t in crops)
    width, height = round((east - west) / dx), round((south - north) / dy)
    if width * height > 12_000_000:
        raise ValueError('Native mosaic exceeds 12 million samples')
    values = np.full((height, width), np.nan, dtype=np.float64)
    for array, transform in crops:
        col, row = round((transform.c - west) / dx), round((transform.f - north) / dy)
        if abs(transform.c - (west + col * dx)) > 1e-8 or abs(transform.f - (north + row * dy)) > 1e-8:
            raise ValueError('Source pixel grids are not aligned')
        values[row:row + array.shape[0], col:col + array.shape[1]] = array.astype(float).filled(np.nan)
    return values, rasterio.Affine(dx, 0, west, 0, dy, north)


def sample_nodes(values, transform, bounds, width, height, method):
    west, south, east, north = bounds
    x = (np.linspace(west, east, width) - transform.c) / transform.a - .5
    y = (np.linspace(north, south, height) - transform.f) / transform.e - .5
    if method == 'nearest':
        cols, rows = np.floor(x + .5).astype(int), np.floor(y + .5).astype(int)
        if cols.min() < 0 or rows.min() < 0 or cols.max() >= values.shape[1] or rows.max() >= values.shape[0]:
            raise ValueError('Measured source does not cover material corner samples')
        output = values[np.ix_(rows, cols)]
    else:
        cols, rows = np.floor(x).astype(int), np.floor(y).astype(int)
        if cols.min() < 0 or rows.min() < 0 or cols.max() + 1 >= values.shape[1] or rows.max() + 1 >= values.shape[0]:
            raise ValueError('Measured source plus real halo does not cover terrain corner samples')
        fx, fy = (x - cols)[None, :], (y - rows)[:, None]
        output = ((values[np.ix_(rows, cols)] * (1 - fx) + values[np.ix_(rows, cols + 1)] * fx) * (1 - fy)
                  + (values[np.ix_(rows + 1, cols)] * (1 - fx) + values[np.ix_(rows + 1, cols + 1)] * fx) * fy)
    if not np.isfinite(output).all():
        raise ValueError('Source nodata touches requested samples; no invented fill or flat fallback')
    return output


def dimensions(bounds, spacing, limit):
    west, south, east, north = bounds
    scale = 6378137 * math.pi / 180
    east_west = (east - west) * scale * math.cos(math.radians((south + north) / 2))
    north_south = (north - south) * scale
    width, height = math.ceil(east_west / spacing) + 1, math.ceil(north_south / spacing) + 1
    if width > limit or height > limit:
        raise ValueError(f'{spacing} m display samples require {width}×{height}, above {limit}; use smaller bounds')
    return width, height, {'eastWest': round(east_west / (width - 1), 3),
                           'northSouth': round(north_south / (height - 1), 3)}


def write_asset(path, data):
    if len(data) > 8 * 1024**2:
        raise ValueError(f'Runtime asset exceeds 8 MiB: {path.name}')
    path.write_bytes(data)
    return digest(data), len(data)


def build(args):
    bounds = args.bounds
    west, south, east, north = bounds
    if not all(math.isfinite(x) for x in bounds) or not (-180 <= west < east <= 180 and -82.7 <= south < north <= 82.7):
        raise ValueError('Use continuous bounds inside [-180,180] and WorldCover latitude coverage; split antimeridian regions')
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', args.id):
        raise ValueError('Region id must contain lowercase ASCII words separated by hyphens')
    width, height, spacing = dimensions(bounds, 30, 1025)
    mw, mh, mspacing = dimensions(bounds, 10, 2048)
    if width * height > 1_050_625:
        raise ValueError('Terrain mesh exceeds renderer vertex limit')
    area = (width - 1) * spacing['eastWest'] * (height - 1) * spacing['northSouth'] / 1e6
    if area > 1000:
        raise ValueError(f'Bounded extraction limited to 1000 km², requested {area:.1f}')
    target = PUBLIC / args.id
    if target.exists():
        raise ValueError(f'Existing region preserved: {target}. Use a new versioned id.')
    final_target = target
    staging = PUBLIC / f'{args.id}.building'
    if staging.exists():
        raise ValueError(f'Unpublished staging directory preserved for inspection: {staging}')
    manifest_path = PUBLIC / 'manifest.json'
    if manifest_path.exists():
        current = json.loads(manifest_path.read_text())
        if current.get('schemaVersion') != 1 or not isinstance(current.get('regions'), list):
            raise ValueError('Unsupported existing terrain manifest')
        if len(current['regions']) >= 128 or any(r['id'] == args.id for r in current['regions']):
            raise ValueError('Duplicate region id or manifest region limit exceeded')
    budget = RangeBudget(args.max_download_mib * 1024**2)
    cache = Path(__file__).parent / '.cache'
    cache.mkdir(exist_ok=True)
    dem_urls, cover_urls, indexes = discover(bounds)
    print(json.dumps({'stage': 'indexed', 'bounds': bounds, 'grid': [width, height],
                      'material': [mw, mh], 'demSources': dem_urls, 'coverSources': cover_urls}), flush=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        dem_sources = list(pool.map(lambda url: CogSource(url, 'Copernicus GLO-30 2021 COG mirror', budget, cache), dem_urls))
        cover_sources = list(pool.map(lambda url: CogSource(url, 'ESA WorldCover 2021 v200', budget, cache), cover_urls))
    sources = dem_sources + cover_sources
    with RangeGateway(sources) as gateway:
        try:
            with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_MULTIRANGE='SERIAL',
                              GDAL_HTTP_MAX_RETRY=0, GDAL_HTTP_PROXY='',
                              CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',
                              CPL_VSIL_CURL_CHUNK_SIZE=262144, VSI_CACHE=False):
                dem_crops, dem_windows = read_crops(dem_sources, gateway, bounds, 2)
                cover_crops, cover_windows = read_crops(cover_sources, gateway, bounds, 1)
        except Exception as error:
            if gateway.error:
                raise gateway.error from error
            raise
        if gateway.error:
            raise gateway.error
    print(json.dumps({'stage': 'source-windows-read', 'rangeBytes': budget.used,
                      'ranges': budget.requests}), flush=True)
    native_dem, dt = mosaic(dem_crops)
    native_cover, ct = mosaic(cover_crops)
    elevations = np.round(sample_nodes(native_dem, dt, bounds, width, height, 'bilinear'), 2)
    if elevations.min() < -12000 or elevations.max() > 10000:
        raise ValueError('Elevation outside physical validation bounds')
    classes = sample_nodes(native_cover, ct, bounds, mw, mh, 'nearest').astype(np.uint8)
    unknown = set(np.unique(classes)) - set(PALETTE)
    if unknown:
        raise ValueError(f'Missing/unrecognised land-cover classes: {unknown}; no synthetic replacement')
    material = np.zeros((mh, mw, 4), dtype=np.uint8)
    counts = {}
    for code, (label, rgba) in PALETTE.items():
        mask = classes == code
        material[mask] = rgba
        counts[str(code)] = {'class': label, 'samples': int(mask.sum()), 'rgba': list(rgba)}
    checked = now()
    source = {'name': 'Copernicus GLO-30', 'url': 'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM',
              'license': 'Copernicus WorldDEM-30 Full, Free & Open', 'licenseUrl': COP_LICENSE,
              'checkedAt': checked, 'sourceNominalResolutionM': 30, 'verticalDatum': 'EGM2008 orthometric metres',
              'horizontalCRS': 'EPSG:4326', 'datasetType': 'DSM including vegetation and structures',
              'release': 'Copernicus DEM 2021 AWS COG mirror',
              'acquisitionPeriod': 'TanDEM-X 2011–2015; older DEMs may fill source gaps',
              'sourceAssets': dem_urls}
    grid = {'schemaVersion': 1, 'bounds': bounds, 'width': width, 'height': height,
            'elevations': elevations.reshape(-1).tolist(), 'minElevation': float(elevations.min()),
            'maxElevation': float(elevations.max()), 'units': 'meters', 'rowOrder': 'north-to-south',
            'columnOrder': 'west-to-east', 'coordinateGrid': 'regular-longitude-latitude',
            'sampleLayout': 'grid-nodes', 'sampleSpacingApproxM': spacing, 'source': source,
            'interpolation': 'Bilinear numeric native DSM samples, with real 2-sample source halo. No synthetic heights or nodata fill.',
            'processing': {'tool': 'tools/terrain-data/build_region.py', 'version': 1,
                           'outputRoundingM': .01, 'measurementAccuracyClaimedM': None,
                           'sourceNativePixelCentresPreserved': False,
                           'sourcePixelCentresLocatedBeforeInterpolation': True, 'missingDataFilled': False},
            'attribution': COP_ATTRIBUTION, 'liabilityNotice': COP_LIABILITY,
            'fieldVerified': False, 'navigationReady': False,
            'limitations': 'Source DSM resolution remains approximately 30 m. Height encoding precision is not measurement accuracy; no individual rocks, trees, trail passability or current conditions inferred.'}
    target = staging
    target.mkdir(parents=True)
    grid_sha, grid_bytes = write_asset(target / 'terrain-grid.json', encoded_json(grid))
    Image.fromarray(material).save(target / 'surface.png', optimize=True)
    Image.fromarray(classes).save(target / 'classes.png', optimize=True)
    material_bytes_data = (target / 'surface.png').read_bytes()
    material_sha, material_bytes = write_asset(target / 'surface.png', material_bytes_data)
    class_data = (target / 'classes.png').read_bytes()
    coverage = {'schemaVersion': 1, 'bounds': bounds, 'rowOrder': 'north-to-south',
                'columnOrder': 'west-to-east', 'projection': 'regular-longitude-latitude',
                'sampleLayout': 'grid-nodes', 'terrainValidSamples': width * height,
                'terrainTotalSamples': width * height, 'materialValidSamples': mw * mh,
                'materialTotalSamples': mw * mh, 'grid': [width, height], 'material': [mw, mh],
                'terrainSampleSpacingApproxM': spacing, 'materialSampleSpacingApproxM': mspacing,
                'materialPaletteVersion': MATERIAL_PALETTE_VERSION, 'classHistogram': counts}
    write_asset(target / 'coverage.json', encoded_json(coverage))
    provenance = {'schemaVersion': 1, 'generatedAt': checked, 'generator': 'tools/terrain-data/build_region.py',
                  'bounds': bounds, 'command': {'id': args.id, 'bounds': bounds, 'maxDownloadMiB': args.max_download_mib},
                  'software': {'rasterio': rasterio.__version__, 'gdal': rasterio.__gdal_version__, 'numpy': np.__version__},
                  'indexes': indexes, 'sources': [s.provenance() for s in sources],
                  'nativeWindows': {'dem': dem_windows, 'landCover': cover_windows},
                  'totalRangeReadBytes': budget.used, 'rangeRequestCount': budget.requests,
                  'totalIndexBytes': sum(index['downloadedBytes'] for index in indexes),
                  'verticalDatum': 'EGM2008', 'heightUnits': 'metres',
                  'noDataPolicy': 'Fail on any missing source sample required for output; no inferred ocean, fake terrain or silent fallback',
                  'materialPolicy': 'Nearest-neighbour measured ESA WorldCover classes mapped to documented Tropnik palette. No photoreal texture or individual objects claimed.',
                  'materialPaletteVersion': MATERIAL_PALETTE_VERSION,
                  'attributions': [COP_ATTRIBUTION, COVER_ATTRIBUTION], 'liabilityNotice': COP_LIABILITY,
                  'licenses': [COP_LICENSE, 'https://creativecommons.org/licenses/by/4.0/'],
                  'artifacts': {'terrain-grid.json': {'sha256': grid_sha, 'bytes': grid_bytes},
                                'surface.png': {'sha256': material_sha, 'bytes': material_bytes},
                                'classes.png': {'sha256': digest(class_data), 'bytes': len(class_data)}}}
    write_asset(target / 'provenance.json', encoded_json(provenance))
    entry = {'id': args.id, 'bounds': bounds, 'gridUrl': f'/terrain-regions/{args.id}/terrain-grid.json',
             'materialUrl': f'/terrain-regions/{args.id}/surface.png',
             'gridSha256': grid_sha, 'materialSha256': material_sha, 'gridBytes': grid_bytes,
             'materialBytes': material_bytes,
             'material': {'width': mw, 'height': mh, 'bounds': bounds,
                          'projection': 'regular-longitude-latitude', 'sampleLayout': 'grid-nodes',
                          'rowOrder': 'north-to-south', 'columnOrder': 'west-to-east',
                          'source': 'ESA WorldCover 2021', 'nominalResolutionM': 10,
                          'paletteVersion': MATERIAL_PALETTE_VERSION,
                          'sampleSpacingApproxM': mspacing, 'license': 'CC BY 4.0',
                          'attribution': COVER_ATTRIBUTION, 'classUrl': f'/terrain-regions/{args.id}/classes.png'},
             'provenance': {'url': f'/terrain-regions/{args.id}/provenance.json',
                            'coverageUrl': f'/terrain-regions/{args.id}/coverage.json',
                            'source': 'Copernicus GLO-30 + ESA WorldCover 2021',
                            'verticalDatum': 'EGM2008', 'sourceNominalResolutionM': 30,
                            'generatedAt': checked, 'measuredTerrain': True,
                            'attributions': [COP_ATTRIBUTION, COVER_ATTRIBUTION]}}
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'schemaVersion': 1, 'regions': []}
    if any(region['id'] == args.id for region in manifest['regions']) or len(manifest['regions']) >= 128:
        raise ValueError('Duplicate region id or manifest region limit exceeded')
    manifest['regions'].append(entry)
    manifest['regions'].sort(key=lambda item: item['id'])
    temporary = manifest_path.with_suffix('.partial')
    temporary.write_bytes(encoded_json(manifest))
    target.rename(final_target)
    temporary.replace(manifest_path)
    print(json.dumps({'stage': 'complete', 'id': args.id, 'grid': [width, height], 'material': [mw, mh],
                      'heightRangeM': [grid['minElevation'], grid['maxElevation']],
                      'gridBytes': grid_bytes, 'materialBytes': material_bytes,
                      'sourceRangeBytes': budget.used}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--id', required=True, help='New versioned region slug; existing output is never overwritten')
    parser.add_argument('--bounds', nargs=4, type=float, required=True, metavar=('WEST', 'SOUTH', 'EAST', 'NORTH'))
    parser.add_argument('--max-download-mib', type=int, default=64, choices=range(1, 129), metavar='1..128')
    args = parser.parse_args()
    build(args)


if __name__ == '__main__':
    main()
