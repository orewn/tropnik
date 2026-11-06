#!/usr/bin/env python3
"""Build a bounded, attributed DEM pilot; never invent or fill missing elevations.

Input is Mapterhorn's public Terrarium WEBP512. Numeric heights, rather than RGB
channels, are resampled to PNG256 for a small Android/WebGL raster-dem package.
The 129x129 mesh is independently sampled from original WEBP512 pixels.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import io
import json
import math
import shutil
import urllib.request

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/terrain-pilot'
BOUNDS = [40.29, 43.64, 40.49, 43.82]
MIN_ZOOM, MAX_ZOOM = 7, 12
INPUT_SIZE, TILE_SIZE = 512, 256
UA = 'Tropa-development/0.1 (bounded offline terrain pilot; https://tropa-rf-atlas-2026.wintrybluebell1.chatgpt.site)'
URL_TEMPLATE = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'
MAX_SOURCE_BYTES = 12_000_000
MAX_RUNTIME_BYTES = 3 * 1024 * 1024
ATTRIBUTION = ('Terrain © Mapterhorn; produced using Copernicus WorldDEM-30 '
               '© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 '
               'provided under COPERNICUS by the European Union and ESA; all rights reserved')
DISCLAIMER = ('The organisations in charge of the Copernicus programme by law or by '
              'delegation do not incur any liability for any use of the Copernicus WorldDEM-30.')


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')


def tile_xy(lon, lat, z):
    n = 2 ** z
    return (n * (lon + 180) / 360,
            n * (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2)


def bounds_for_tiles(z, x0, y0, x1, y1):
    n = 2 ** z
    latitude = lambda y: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return [x0 / n * 360 - 180, latitude(y1 + 1),
            (x1 + 1) / n * 360 - 180, latitude(y0)]


def decode(image):
    rgb = np.asarray(image.convert('RGB'), dtype=np.float64)
    return rgb[:, :, 0] * 256 + rgb[:, :, 1] + rgb[:, :, 2] / 256 - 32768


def encode(heights):
    # Terrarium has 1/256m encoding precision, not 1/256m measurement accuracy.
    q = np.rint((heights + 32768) * 256).clip(0, 2**24 - 1).astype(np.uint32)
    rgb = np.stack([(q >> 16) & 255, (q >> 8) & 255, q & 255], axis=-1).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def get_tile(key):
    z, x, y = key
    url = URL_TEMPLATE.format(z=z, x=x, y=y)
    request = urllib.request.Request(url, headers={'User-Agent': UA})
    # One ordinary public download. HTTP denials are errors, not retried via a
    # different identity, proxy, endpoint or credential.
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError(f'Unexpectedly large terrain tile: {url}')
        headers = {k.lower(): v for k, v in response.headers.items()
                   if k.lower() in ('last-modified', 'etag', 'content-type', 'content-length', 'cache-control')}
    image = Image.open(io.BytesIO(raw))
    if image.size != (INPUT_SIZE, INPUT_SIZE):
        raise ValueError(f'Unexpected DEM tile dimensions: {image.size} {url}')
    heights = decode(image)
    if not np.isfinite(heights).all():
        raise ValueError(f'Nonfinite DEM heights: {url}')
    # At exact 2:1 reduction this average equals bilinear interpolation at each
    # destination pixel centre. Never resize encoded RGB as ordinary imagery.
    small = heights.reshape(TILE_SIZE, 2, TILE_SIZE, 2).mean(axis=(1, 3))
    png = encode(small)
    if np.max(np.abs(decode(Image.open(io.BytesIO(png))) - small)) > 1/512 + 1e-8:
        raise ValueError('Terrarium roundtrip exceeded encoding precision')
    rel = f'tiles/{z}/{x}/{y}.png'
    path = OUT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)
    record = {'path': rel, 'z': z, 'x': x, 'y': y, 'sizeBytes': len(png),
              'sha256': sha(png), 'sourceUrl': url, 'sourceSizeBytes': len(raw),
              'sourceSha256': sha(raw), 'retrievedAt': now(), 'httpHeaders': headers}
    write_json(OUT / f'sources/tile-records/{z}-{x}-{y}.json', record)
    return key, record, heights if z == MAX_ZOOM else None


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if (OUT / 'manifest.json').exists():
        raise SystemExit('Existing complete terrain package: preserve it; use a new version directory to refresh.')
    # A failed, unpublished attempt is safe to replace; never touch a completed
    # package, shared map assets, or any other dataset.
    if (OUT / 'tiles').exists():
        shutil.rmtree(OUT / 'tiles')
    keys, tile_extents = [], {}
    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        west, north = tile_xy(BOUNDS[0], BOUNDS[3], z)
        east, south = tile_xy(BOUNDS[2], BOUNDS[1], z)
        halo = 0
        x0, x1 = math.floor(west) - halo, math.floor(east) + halo
        y0, y1 = math.floor(north) - halo, math.floor(south) + halo
        tile_extents[str(z)] = {'tileRange': [x0, y0, x1, y1],
                                'bounds': bounds_for_tiles(z, x0, y0, x1, y1)}
        keys.extend((z, x, y) for x in range(x0, x1+1) for y in range(y0, y1+1))
    assert len(keys) <= 40
    records, cache, source_size, runtime_size = [], {}, 0, 0
    print(json.dumps({'requestedTiles': len(keys), 'bounds': BOUNDS, 'minzoom': MIN_ZOOM, 'maxzoom': MAX_ZOOM}), flush=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(get_tile, key) for key in keys]
        for future in as_completed(futures):
            key, record, heights = future.result()
            records.append(record)
            source_size += record['sourceSizeBytes']
            runtime_size += record['sizeBytes']
            if source_size > MAX_SOURCE_BYTES or runtime_size > MAX_RUNTIME_BYTES:
                for pending in futures:
                    pending.cancel()
                raise ValueError('Package exceeds its bounded byte budget; no complete manifest written.')
            if heights is not None:
                cache[key] = heights
            if len(records) % 10 == 0 or len(records) == len(keys):
                print(json.dumps({'tiles': len(records), 'runtimePngBytes': runtime_size, 'downloadBytes': source_size}), flush=True)
    records.sort(key=lambda r: (r['z'], r['x'], r['y']))
    selected_paths = {record['path'] for record in records}
    for path in (OUT / 'tiles').rglob('*.png'):
        if path.relative_to(OUT).as_posix() not in selected_paths:
            path.unlink()

    def pixel(ix, iy):
        tx, px = divmod(ix, INPUT_SIZE)
        ty, py = divmod(iy, INPUT_SIZE)
        return float(cache[(MAX_ZOOM, tx, ty)][py, px])

    def height(lon, lat):
        x, y = tile_xy(lon, lat, MAX_ZOOM)
        gx, gy = x * INPUT_SIZE - .5, y * INPUT_SIZE - .5
        ix, iy = math.floor(gx), math.floor(gy)
        fx, fy = gx - ix, gy - iy
        return ((pixel(ix, iy) * (1-fx) + pixel(ix+1, iy) * fx) * (1-fy)
                + (pixel(ix, iy+1) * (1-fx) + pixel(ix+1, iy+1) * fx) * fy)

    width = height_count = 129
    elevations = [round(height(BOUNDS[0] + (BOUNDS[2]-BOUNDS[0]) * col/(width-1),
                               BOUNDS[3] - (BOUNDS[3]-BOUNDS[1]) * row/(height_count-1)), 1)
                  for row in range(height_count) for col in range(width)]
    assert len(elevations) == 16641 and all(math.isfinite(value) for value in elevations)
    checked = now()
    source = {'name': 'Mapterhorn / Copernicus GLO-30', 'url': 'https://mapterhorn.com/data-access/',
              'urlTemplate': URL_TEMPLATE, 'attributionUrl': 'https://mapterhorn.com/attribution/',
              'license': 'Copernicus WorldDEM-30 Full, Free & Open licence (included)',
              'licensePath': 'sources/Copernicus-GLO30-LICENSE.pdf',
              'checkedAt': checked, 'sourceNominalResolutionM': 30,
              'sourceAcquisitionPeriod': 'TanDEM-X 2011–2015; some infill elevations can be older',
              'mapterhornSourceAccessYear': 2025, 'sourceTileZoom': MAX_ZOOM,
              'sourceTileSize': INPUT_SIZE, 'datasetType': 'DSM (surface, including vegetation and structures)',
              'verticalDatum': 'Copernicus GLO-30 source: EGM2008; no independent datum transformation validated',
              'sourceSelectionNote': 'Global GLO-30 source, inferred from Mapterhorn published source coverage; endpoint does not expose per-pixel source IDs.'}
    grid = {'schemaVersion': 1, 'bounds': BOUNDS, 'width': width, 'height': height_count,
            'elevations': elevations, 'minElevation': min(elevations), 'maxElevation': max(elevations),
            'units': 'meters', 'rowOrder': 'north-to-south', 'columnOrder': 'west-to-east',
            'coordinateGrid': 'regular-longitude-latitude',
            'interpolation': 'Bilinear on decoded source WEBP512 heights at zoom 12; no generated or filled points',
            'sampleSpacingApproxM': {'eastWest': round((BOUNDS[2]-BOUNDS[0])*111320*math.cos(math.radians(sum(BOUNDS[1::2])/2))/(width-1), 1),
                                    'northSouth': round((BOUNDS[3]-BOUNDS[1])*111320/(height_count-1), 1)},
            'source': source, 'attribution': ATTRIBUTION, 'liabilityNotice': DISCLAIMER,
            'fieldVerified': False, 'navigationReady': False,
            'limitations': 'Regional terrain visualization. Not a trail surface survey, obstacle model, snow or avalanche assessment. Mesh sampling is coarser than the source DEM.'}
    write_json(OUT / 'terrain-grid.json', grid)
    tilejson = {'tilejson': '3.0.0', 'scheme': 'xyz', 'name': 'Tropa — Bzerpinsky bounded terrain',
                'tiles': ['tiles/{z}/{x}/{y}.png'], 'minzoom': MIN_ZOOM, 'maxzoom': MAX_ZOOM,
                'bounds': BOUNDS, 'encoding': 'terrarium', 'tileSize': TILE_SIZE, 'attribution': ATTRIBUTION}
    write_json(OUT / 'tilejson.json', tilejson)
    (OUT / 'ATTRIBUTION.txt').write_text(ATTRIBUTION + '\n\n' + DISCLAIMER + '\n\n'
        'These derivative terrain tiles and the mesh use Copernicus GLO-30 under its included licence. '
        'Downstream redistribution must retain the attribution, liability notice and licence obligations. '
        'The project is not endorsed by Mapterhorn, DLR, Airbus, the European Union or ESA.\n'
        'Mapterhorn: https://mapterhorn.com/attribution/\n'
        'Data access: https://mapterhorn.com/data-access/\n'
        'Copernicus dataset: https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM\n')
    file_records = []
    for path in sorted(OUT.rglob('*')):
        if path.is_file() and path.name != 'manifest.json':
            data = path.read_bytes()
            file_records.append({'path': path.relative_to(OUT).as_posix(), 'sizeBytes': len(data), 'sha256': sha(data)})
    total = sum(r['sizeBytes'] for r in file_records)
    if total > MAX_RUNTIME_BYTES:
        raise ValueError(f'Package including metadata exceeds 3MiB: {total}; no complete manifest written.')
    manifest = {'schemaVersion': 1, 'id': 'tropa-bzerpinsky-terrain-2026-11-06',
                'complete': True, 'builtAt': checked, 'bounds': BOUNDS,
                'minzoom': MIN_ZOOM, 'maxzoom': MAX_ZOOM, 'tileSize': TILE_SIZE,
                'encoding': 'terrarium', 'format': 'PNG', 'scheme': 'xyz',
                'tileUrlTemplate': 'tiles/{z}/{x}/{y}.png', 'gridPath': 'terrain-grid.json',
                'tileCount': len(records), 'source': source, 'attribution': ATTRIBUTION,
                'liabilityNotice': DISCLAIMER, 'downloadBytes': source_size,
                'totalFileBytesExcludingManifest': total, 'byteBudget': MAX_RUNTIME_BYTES,
                'requestedBounds': BOUNDS, 'tileExtentsByZoom': tile_extents,
                'packingChoice': 'Exact AOI tile coverage without an extra halo, to preserve numeric precision within the native byte budget',
                'processing': {'tiles': 'Decode Terrarium512 to meters, average 2x2 scalar heights, encode TerrariumPNG256; no RGB interpolation',
                               'grid': grid['interpolation'], 'numericEncodingPrecisionM': 1/256,
                               'measurementAccuracyClaimedM': None, 'concurrency': 2,
                               'userAgent': UA, 'missingDataFilled': False},
                'fieldVerified': False, 'navigationReady': False,
                'tiles': records, 'files': file_records}
    write_json(OUT / 'manifest.json', manifest)
    # Publish an explicit file allowlist into a new clean runtime namespace.
    # Consumers must not include unrelated working/staging files in an APK.
    runtime = OUT / 'runtime'
    for record in file_records + [{'path': 'manifest.json'}]:
        target = runtime / record['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUT / record['path'], target)
    print(json.dumps({'complete': True, 'out': str(OUT), 'tiles': len(records),
                      'runtimePath': str(runtime),
                      'packageBytes': total + (OUT/'manifest.json').stat().st_size,
                      'sourceBytes': source_size, 'gridShape': [width, height_count],
                      'elevationRangeM': [min(elevations), max(elevations)],
                      'manifestSha256': sha((OUT/'manifest.json').read_bytes())}), flush=True)


if __name__ == '__main__':
    main()
