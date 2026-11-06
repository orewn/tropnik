#!/usr/bin/env python3
"""Build a complete z0..4 XYZ overview from pinned, public-domain Natural Earth.

The historical image is shaded relief, not a DEM. No heights or landcover are
inferred. The existing RF display geometry only supplies its alpha mask.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import Point, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
COMMIT = 'f04832c819e7a203d159dffe93cd9245332d6b33'
BASE = f'https://raw.githubusercontent.com/nvkelso/natural-earth-raster/{COMMIT}/50m_rasters/SR_50M/'
SOURCE_FILES = {
    'SR_50M.VERSION.txt': ('359a5b952d49f3592571e2af081510656029298e', 5),
    'SR_50M.prj': ('b13a71791932a9ecb82a81800e49b3d5b307a195', 147),
    'SR_50M.tfw': ('6271b06423dccb54186d7e33284c8c28af7185a9', 173),
    'SR_50M.tif': ('881f7162db2c57b308c73976b0039935e715d1fc', 58401016),
}
TILE_SIZE = 256
MIN_ZOOM = 0
MAX_ZOOM = 4
MAX_LAT = 85.0511287798066
BASE_COLOR = np.array([219, 228, 205], dtype=np.float32)
SHADOW_FLOOR = 0.62
MASK_SHA = '6731c4ae30d8643df3dc917416769ce4c4be98e1936458c145464e1387e1087b'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_source(directory, download):
    directory.mkdir(parents=True, exist_ok=True)
    records = []
    for name, (expected, length) in SOURCE_FILES.items():
        path = directory / name
        if not path.exists():
            if not download:
                raise ValueError(f'Missing pinned source {path}; provide it or use --download')
            request = Request(BASE + name, headers={'User-Agent': 'Tropnik-overview-relief/0.1 (public-domain source download)'})
            with urlopen(request, timeout=30) as response:
                data = response.read(length + 1)
            if len(data) != length:
                raise ValueError(f'Unexpected source length: {name}')
            candidate = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            if candidate != expected:
                raise ValueError(f'Pinned source SHA mismatch: {name}')
            path.write_bytes(data)
        git = hashlib.sha1(b'blob ' + str(path.stat().st_size).encode() + b'\0')
        sha = hashlib.sha256()
        with path.open('rb') as stream:
            for part in iter(lambda: stream.read(1024 * 1024), b''):
                git.update(part)
                sha.update(part)
        if path.stat().st_size != length or git.hexdigest() != expected:
            raise ValueError(f'Pinned source changed: {name}')
        records.append({'name': name, 'url': BASE + name, 'bytes': length,
                        'gitBlobSha': expected, 'sha256': sha.hexdigest()})
    return records


def project_ring(ring, side):
    points = np.asarray(ring, dtype=np.float64)
    longitude = points[:, 0]
    latitude = np.clip(points[:, 1], -MAX_LAT, MAX_LAT)
    x = (longitude + 180) / 360 * side - .5
    y = (1 - np.arcsinh(np.tan(np.radians(latitude))) / math.pi) / 2 * side - .5
    return list(zip(x.tolist(), y.tolist()))


def alpha_mask(geometry, side):
    # Area-like antialiasing preserves small islands without inventing a buffer.
    scale = 4
    mask = Image.new('L', (side * scale, side * scale), 0)
    drawing = ImageDraw.Draw(mask)
    polygons = [geometry] if geometry.geom_type == 'Polygon' else list(geometry.geoms)
    for polygon in polygons:
        drawing.polygon(project_ring(polygon.exterior.coords, side * scale), fill=255)
        for ring in polygon.interiors:
            drawing.polygon(project_ring(ring.coords, side * scale), fill=0)
    return mask.resize((side, side), Image.Resampling.BOX)


def sample_rows(raster, worldfile, longitude, latitude):
    a, d, b, e, c, f = worldfile
    if b or d or a <= 0 or e >= 0:
        raise ValueError('Only the pinned unrotated WGS84 source worldfile is supported')
    longitude = (np.asarray(longitude) + 180) % 360 - 180
    column = (longitude - c) / a
    row = np.clip((np.asarray(latitude) - f) / e, 0, raster.shape[0] - 1)
    x0 = np.floor(column).astype(np.int64)
    y0 = np.floor(row).astype(np.int64)
    fx = (column - x0).astype(np.float32)[None, :]
    fy = (row - y0).astype(np.float32)[:, None]
    x1 = (x0 + 1) % raster.shape[1]
    x0 %= raster.shape[1]
    y1 = np.minimum(y0 + 1, raster.shape[0] - 1)
    top = raster[y0[:, None], x0].astype(np.float32) * (1 - fx) + raster[y0[:, None], x1] * fx
    bottom = raster[y1[:, None], x0].astype(np.float32) * (1 - fx) + raster[y1[:, None], x1] * fx
    return top * (1 - fy) + bottom * fy


def pixel_for_point(longitude, latitude, side):
    x = ((longitude + 180) % 360) / 360 * side
    y = (1 - math.asinh(math.tan(math.radians(latitude))) / math.pi) / 2 * side
    return min(side - 1, max(0, math.floor(x))), min(side - 1, max(0, math.floor(y)))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def build(args):
    source_records = validate_source(args.source_dir, args.download)
    worldfile = [float(value) for value in (args.source_dir / 'SR_50M.tfw').read_text().split()]
    if len(worldfile) != 6 or 'GCS_WGS_1984' not in (args.source_dir / 'SR_50M.prj').read_text():
        raise ValueError('Missing WGS84 source georeferencing')
    with Image.open(args.source_dir / 'SR_50M.tif') as image:
        if image.size != (10800, 5400) or image.mode != 'L':
            raise ValueError('Unexpected source dimensions or mode')
        raster = np.array(image, dtype=np.uint8)
    mask_path = ROOT / 'web/public/data/russia-canonical-area.geojson'
    mask_bytes = mask_path.read_bytes()
    if digest(mask_bytes) != MASK_SHA:
        raise ValueError('RF display mask changed; review and pin its new provenance explicitly')
    features = json.loads(mask_bytes)['features']
    geometry = unary_union([shape(feature['geometry']) for feature in features])
    if not geometry.is_valid:
        raise ValueError('The pinned display geometry is invalid')
    provenance_path = ROOT / 'web/public/data/russia-boundaries-provenance.json'
    coverage_bytes = provenance_path.read_bytes()
    coverage = json.loads(coverage_bytes)
    args.out.mkdir(parents=True, exist_ok=True)
    records, nonempty = [], 0
    empty_buffer = BytesIO()
    Image.new('RGBA', (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0)).save(empty_buffer, format='PNG', optimize=True)
    empty_bytes = empty_buffer.getvalue()
    maximum_alpha = None
    for zoom in range(MIN_ZOOM, MAX_ZOOM + 1):
        count, side = 2 ** zoom, TILE_SIZE * 2 ** zoom
        mask = alpha_mask(geometry, side)
        if zoom == MAX_ZOOM:
            maximum_alpha = mask
        for x in range(count):
            folder = args.out / str(zoom) / str(x)
            folder.mkdir(parents=True, exist_ok=True)
            longitude = (x * TILE_SIZE + np.arange(TILE_SIZE) + .5) / side * 360 - 180
            for y in range(count):
                alpha = np.asarray(mask.crop((x * TILE_SIZE, y * TILE_SIZE, (x + 1) * TILE_SIZE, (y + 1) * TILE_SIZE)))
                if not np.any(alpha):
                    data = empty_bytes
                else:
                    latitude = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * (y * TILE_SIZE + np.arange(TILE_SIZE) + .5) / side))))
                    gray = sample_rows(raster, worldfile, longitude, latitude)
                    factor = SHADOW_FLOOR + (1 - SHADOW_FLOOR) * gray / 255
                    rgb = np.rint(factor[:, :, None] * BASE_COLOR).clip(0, 255).astype(np.uint8)
                    rgba = np.dstack([rgb, alpha])
                    rgba[alpha == 0, :3] = 0
                    buffer = BytesIO()
                    Image.fromarray(rgba, 'RGBA').save(buffer, format='PNG', optimize=True)
                    data = buffer.getvalue()
                    nonempty += 1
                name = f'{zoom}/{x}/{y}.png'
                (args.out / name).write_bytes(data)
                records.append({'path': name, 'bytes': len(data), 'sha256': digest(data), 'transparent': data == empty_bytes})
        print(f'Built z{zoom}: {count * count} complete XYZ paths', flush=True)
    fixture = json.loads((ROOT / 'web/tests/fixtures/russia-checks.json').read_text())
    point_checks = []
    for point in fixture['pointCases']:
        longitude, latitude = point['inputLngLat']
        px = pixel_for_point(longitude, latitude, TILE_SIZE * 2 ** MAX_ZOOM)
        alpha = maximum_alpha.getpixel(px)
        canonical_longitude = (longitude + 180) % 360 - 180
        vector = geometry.covers(Point(canonical_longitude, latitude))
        point_checks.append({'name': point['name'], 'inputLngLat': point['inputLngLat'],
                             'expectedInside': point['expectedInside'], 'vectorContains': vector,
                             'z4Alpha': alpha, 'rasterMatchesFixture': (alpha > 0) == point['expectedInside']})
    if not all(case['rasterMatchesFixture'] and case['vectorContains'] == case['expectedInside'] for case in point_checks):
        raise ValueError('An overview control point failed: ' + json.dumps(point_checks))
    for longitude in [-169.8092, 177.45, 179.999, -179.999]:
        np.testing.assert_allclose(sample_rows(raster, worldfile, [longitude], [66.1599]),
                                   sample_rows(raster, worldfile, [longitude + 360], [66.1599]), atol=1e-5)
        assert pixel_for_point(longitude, 66.1599, 4096) == pixel_for_point(longitude + 360, 66.1599, 4096)
    version = (args.source_dir / 'SR_50M.VERSION.txt').read_text().strip()
    attribution = 'Made with Natural Earth. RF display coverage: © OpenStreetMap contributors · geoBoundaries.'
    tilejson = {'tilejson': '3.0.0', 'name': 'Тропник · обзорный рельеф РФ', 'version': '1.0.0',
                'scheme': 'xyz', 'tiles': ['/maps/russia-relief/{z}/{x}/{y}.png'],
                'minzoom': MIN_ZOOM, 'maxzoom': MAX_ZOOM,
                'bounds': [-180, -MAX_LAT, 180, MAX_LAT], 'attribution': attribution}
    write_json(args.out / 'tilejson.json', tilejson)
    manifest = {
        'schemaVersion': 1, 'id': 'natural-earth-rf-overview-v1', 'complete': True,
        'builtAt': datetime.now(timezone.utc).isoformat(), 'purpose': 'Local cartographic overview only',
        'terrainElevationData': False, 'navigationReady': False, 'tileScheme': 'xyz',
        'tileSize': TILE_SIZE, 'minzoom': MIN_ZOOM, 'maxzoom': MAX_ZOOM,
        'maxNativeZoom': MAX_ZOOM, 'recommendedLayerMaxZoom': 6, 'wrapX': True,
        'tileTemplate': '/maps/russia-relief/{z}/{x}/{y}.png', 'bounds': tilejson['bounds'],
        'displayBounds': [*coverage['fitBounds'][0], *coverage['fitBounds'][1]],
        'projection': 'EPSG:3857', 'sourceProjection': 'EPSG:4326',
        'source': {'name': 'Natural Earth SR_50M', 'usedVersion': version, 'cartographicScale': '1:50,000,000',
                   'description': 'Historical grayscale shaded-relief image; not numeric elevation data',
                   'sourcePage': 'https://www.naturalearthdata.com/downloads/50m-raster-data/50m-shaded-relief/',
                   'currentWebsiteAdvertisedVersion': '3.2.0',
                   'repository': 'https://github.com/nvkelso/natural-earth-raster', 'commit': COMMIT,
                   'commitDate': '2012-11-05T11:17:41Z', 'files': source_records,
                   'license': 'Public Domain', 'licenseUrl': 'https://www.naturalearthdata.com/about/terms-of-use/',
                   'dimensions': [10800, 5400], 'angularPixelSizeDegrees': [worldfile[0], abs(worldfile[3])],
                   'worldfilePixelCenterTransform': worldfile, 'resampling': 'Bilinear at Web Mercator pixel centers'},
        'mask': {'path': '/data/russia-canonical-area.geojson', 'sha256': MASK_SHA,
                 'provenanceUrl': '/data/russia-boundaries-provenance.json', 'provenanceSha256': digest(coverage_bytes),
                 'license': coverage['license'], 'licenseUrl': coverage['licenseUrl'],
                 'attribution': coverage['attribution'], 'geometryChanged': False,
                 'rasterization': '4x supersampled polygon alpha averaged to the target pixel; no geometry buffer'},
        'tint': {'baseColor': '#DBE4CD', 'formula': 'RGB = round(baseRGB * (0.62 + 0.38 * grayscale / 255))',
                 'meaning': 'Cartographic tint only; no vegetation, height or weather classification'},
        'attribution': attribution, 'tileCount': len(records), 'nonemptyTileCount': nonempty,
        'transparentTileCount': len(records) - nonempty, 'transparentTileSha256': digest(empty_bytes),
        'totalTileBytes': sum(record['bytes'] for record in records), 'files': records,
        'validation': {'expectedTileCount': sum(4 ** z for z in range(MIN_ZOOM, MAX_ZOOM + 1)),
                       'allExpectedXYZPathsPresent': len(records) == 341, 'pointChecks': point_checks,
                       'datelineWrapEquivalentPointsPassed': 4, 'sourceGitBlobHashesPassed': True},
        'limitations': ['Historical small-scale shaded relief, not recent satellite imagery or a DEM.',
                        'The 50M source label means cartographic scale 1:50 million, not 50-metre detail.',
                        'This overview does not provide detailed offline maps or trails for all Russia.',
                        'Light and shadows are baked cartographic shading, not actual sun or weather.',
                        'A raster edge is an area sample of the separately published display mask, not a legal boundary.'],
    }
    write_json(args.out / 'manifest.json', manifest)
    (args.out / 'ATTRIBUTION.txt').write_text(attribution + '\n\nShaded relief: Natural Earth SR_50M version ' + version + ', Public Domain.\nhttps://www.naturalearthdata.com/about/terms-of-use/\n\n' + coverage['attribution'] + '\nDisplay mask source database: ' + coverage['license'] + '\n' + coverage['licenseUrl'] + '\n\nHistorical, tinted, reprojected cartographic overview. Not a DEM, current imagery, current illumination, a legal boundary or a detailed navigation map.\n')
    print(json.dumps({key: manifest[key] for key in ['id', 'tileCount', 'nonemptyTileCount', 'transparentTileCount', 'totalTileBytes']}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, default=ROOT / 'data/overview-relief/raw')
    parser.add_argument('--out', type=Path, default=ROOT / 'web/public/maps/russia-relief')
    parser.add_argument('--download', action='store_true')
    build(parser.parse_args())
