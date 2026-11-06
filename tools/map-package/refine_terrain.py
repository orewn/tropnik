#!/usr/bin/env python3
"""Build a denser display mesh from the existing, immutable terrain archive.

Run from any directory with Python 3, NumPy and Pillow. This script never uses
the network and never writes to data/terrain-pilot/runtime. The 513 by 513
mesh samples archived, manifest-verified PNG256 heights, not the original
WEBP512 files. More display samples do not imply better survey accuracy.
Use --check, or verify(project_root), to verify the published derivative
without changing any files before packaging it in another client.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

import numpy as np
from PIL import Image


ARCHIVE = Path('data/terrain-pilot/runtime')
GRID = Path('web/public/terrain/terrain-grid.json')
PREVIEW = Path('web/public/terrain/terrain-preview.json')
EVIDENCE = Path('docs/verification/terrain-refinement.json')
ZOOM, TILE_SIZE, GRID_SIZE, PREVIEW_SIZE = 12, 256, 513, 129


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value, *, pretty=False) -> bytes:
    options = {'indent': 2} if pretty else {'separators': (',', ':')}
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, **options) + '\n').encode('utf-8')


def checked_path(root: Path, name: str) -> Path:
    relative = PurePosixPath(name)
    if not name or '\\' in name or relative.is_absolute() or '..' in relative.parts:
        raise ValueError(f'Invalid archive-relative path: {name!r}')
    path = root.joinpath(*relative.parts)
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'Archive path escapes its root: {name}')
    return path


def verify_bytes(data: bytes, record: dict) -> None:
    if len(data) != record['sizeBytes'] or sha256(data) != record['sha256']:
        raise ValueError(f'Archive integrity mismatch: {record["path"]}')


def snapshot(root: Path) -> list[dict]:
    return [{'path': path.relative_to(root).as_posix(), 'sizeBytes': path.stat().st_size,
             'sha256': sha256(path.read_bytes())}
            for path in sorted(root.rglob('*')) if path.is_file()]


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class TerrainArchive:
    def __init__(self, root: Path):
        self.root = root
        self.manifest_bytes = (root / 'manifest.json').read_bytes()
        self.manifest = json.loads(self.manifest_bytes)
        manifest = self.manifest
        if (manifest.get('complete') is not True or manifest.get('encoding') != 'terrarium'
                or manifest.get('format') != 'PNG' or manifest.get('scheme') != 'xyz'
                or manifest.get('tileSize') != TILE_SIZE or manifest.get('maxzoom') != ZOOM):
            raise ValueError('Expected a complete XYZ Terrarium PNG256 archive through zoom 12')
        self.bounds = np.asarray(manifest['bounds'], dtype=np.float64)
        if (self.bounds.shape != (4,) or not np.isfinite(self.bounds).all()
                or not (-180 <= self.bounds[0] < self.bounds[2] <= 180)
                or not (-85.05112878 < self.bounds[1] < self.bounds[3] < 85.05112878)):
            raise ValueError('Invalid WGS84 archive bounds')

        # Verify every manifest file, including the original grid and licence.
        self.records = {}
        for record in manifest['files']:
            name = record['path']
            if name in self.records:
                raise ValueError(f'Duplicate file record: {name}')
            verify_bytes(checked_path(root, name).read_bytes(), record)
            self.records[name] = record
        if len(manifest['tiles']) != manifest['tileCount']:
            raise ValueError('Tile count does not match the complete manifest')

        self.tiles, self.selected_records = {}, []
        for record in manifest['tiles']:
            canonical = f'tiles/{record["z"]}/{record["x"]}/{record["y"]}.png'
            file_record = self.records.get(canonical)
            if (record['path'] != canonical or file_record is None
                    or any(record[key] != file_record[key] for key in ('sha256', 'sizeBytes'))):
                raise ValueError(f'Inconsistent tile and file records: {record["path"]}')
            if record['z'] != ZOOM:
                continue
            key = record['x'], record['y']
            if key in self.tiles:
                raise ValueError(f'Duplicate source tile: {key}')
            raw = checked_path(root, canonical).read_bytes()
            verify_bytes(raw, record)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != 'PNG' or image.size != (TILE_SIZE, TILE_SIZE) or image.mode != 'RGB':
                    raise ValueError(f'Expected RGB PNG256: {canonical}')
                rgb = np.asarray(image, dtype=np.float64)
            # Decode to metres BEFORE interpolation. Never resize RGB channels.
            heights = rgb[:, :, 0] * 256 + rgb[:, :, 1] + rgb[:, :, 2] / 256 - 32768
            if not np.isfinite(heights).all():
                raise ValueError(f'Nonfinite source elevations: {canonical}')
            self.tiles[key] = heights
            self.selected_records.append(record)
        if not self.tiles:
            raise ValueError('No verified zoom-12 source tiles')
        self.selected_records.sort(key=lambda item: (item['x'], item['y']))

        x0, y0 = min(x for x, _ in self.tiles), min(y for _, y in self.tiles)
        x1, y1 = max(x for x, _ in self.tiles), max(y for _, y in self.tiles)
        self.origin = x0 * TILE_SIZE, y0 * TILE_SIZE
        self.mosaic = np.full(((y1 - y0 + 1) * TILE_SIZE, (x1 - x0 + 1) * TILE_SIZE), np.nan)
        for (x, y), heights in self.tiles.items():
            self.mosaic[(y-y0)*TILE_SIZE:(y-y0+1)*TILE_SIZE,
                        (x-x0)*TILE_SIZE:(x-x0+1)*TILE_SIZE] = heights

    def pixels(self, ix, iy):
        ix, iy = np.broadcast_arrays(np.asarray(ix, dtype=np.int64), np.asarray(iy, dtype=np.int64))
        x, y = ix - self.origin[0], iy - self.origin[1]
        if (np.any(x < 0) or np.any(x >= self.mosaic.shape[1])
                or np.any(y < 0) or np.any(y >= self.mosaic.shape[0])):
            raise ValueError('Interpolation needs pixels outside the archived tile extent')
        result = self.mosaic[y, x]
        if not np.isfinite(result).all():
            raise ValueError('Interpolation needs a missing archived tile; no filling is allowed')
        return result

    def sample(self, lon, lat):
        world_pixels = (2 ** ZOOM) * TILE_SIZE
        gx = (np.asarray(lon) + 180) / 360 * world_pixels - 0.5
        gy = (1 - np.arcsinh(np.tan(np.radians(np.asarray(lat)))) / math.pi) / 2 * world_pixels - 0.5
        ix, iy = np.floor(gx).astype(np.int64), np.floor(gy).astype(np.int64)
        fx, fy = gx - ix, gy - iy
        # Four real neighbours are required, including across XYZ tile seams.
        return ((self.pixels(ix, iy) * (1-fx) + self.pixels(ix+1, iy) * fx) * (1-fy)
                + (self.pixels(ix, iy+1) * (1-fx) + self.pixels(ix+1, iy+1) * fx) * fy)

    def scalar_sample(self, lon: float, lat: float) -> float:
        # Separate scalar path for cross-checking vectorized sampling and seams.
        world_pixels = 2 ** ZOOM * TILE_SIZE
        gx = (lon + 180) / 360 * world_pixels - 0.5
        gy = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * world_pixels - 0.5
        ix, iy = math.floor(gx), math.floor(gy)
        fx, fy = gx-ix, gy-iy
        result = 0.0
        for dx, wx in ((0, 1-fx), (1, fx)):
            for dy, wy in ((0, 1-fy), (1, fy)):
                tx, px = divmod(ix+dx, TILE_SIZE)
                ty, py = divmod(iy+dy, TILE_SIZE)
                result += float(self.tiles[(tx, ty)][py, px]) * wx * wy
        return result


def verify_sampling(archive: TerrainArchive, lons, lats, samples) -> dict:
    indices = sorted({0, 1, 64, 128, 255, 256, 384, 511, 512})
    maximum_error = max(abs(float(samples[row, col]) - archive.scalar_sample(float(lons[col]), float(lats[row])))
                        for row in indices for col in indices)
    if maximum_error > 1e-6:
        raise ValueError(f'Scalar/vector interpolation mismatch: {maximum_error}')

    # Pixel-centre values are an independent fixed-point oracle for georeferencing.
    centre_errors = []
    world_pixels = 2 ** ZOOM * TILE_SIZE
    for (tx, ty), heights in sorted(archive.tiles.items()):
        for px, py in ((1, 1), (127, 127), (254, 254)):
            gx, gy = tx*TILE_SIZE+px+0.5, ty*TILE_SIZE+py+0.5
            lon = gx/world_pixels*360-180
            lat = math.degrees(math.atan(math.sinh(math.pi*(1-2*gy/world_pixels))))
            centre_errors.append(abs(float(archive.sample(lon, lat))-float(heights[py, px])))
    if max(centre_errors) > 1e-6:
        raise ValueError('WebMercator pixel-centre roundtrip failed')

    # Verify that an absent neighbour is rejected, not clamped or fabricated.
    try:
        archive.pixels(archive.origin[0]-1, archive.origin[1])
    except ValueError:
        missing_rejected = True
    else:
        raise ValueError('Missing-neighbour policy failed')

    return {'scalarCrossCheckSamples': len(indices)**2,
            'scalarCrossCheckMaxAbsErrorM': maximum_error,
            'pixelCentreCrossCheckSamples': len(centre_errors),
            'pixelCentreMaxAbsErrorM': max(centre_errors),
            'numericCrossCheckToleranceM': 1e-6,
            'missingNeighbourRejected': missing_rejected}


def comparison(old_grid: dict, new_values: np.ndarray, bounds) -> dict:
    old = np.asarray(old_grid['elevations'], dtype=np.float64).reshape(PREVIEW_SIZE, PREVIEW_SIZE)
    aligned = new_values[::4, ::4]
    delta = aligned - old
    absolute = np.abs(delta)
    points = [('north_west', 0, 0), ('north_east', 0, 128), ('centre', 64, 64),
              ('south_west', 128, 0), ('south_east', 128, 128)]
    for label, index in [('original_minimum', int(old.argmin())), ('original_maximum', int(old.argmax())),
                         ('largest_absolute_difference', int(absolute.argmax()))]:
        row, col = divmod(index, PREVIEW_SIZE)
        points.append((label, row, col))
    return {'comparison': 'All original 129 by 129 coordinates coincide with every fourth new grid node.',
            'reasonForDifference': 'Original preview samples WEBP512; new grid samples its archived 2 by 2 scalar-averaged PNG256 derivative. Both outputs are rounded to 0.1 m.',
            'measurementAccuracyClaim': None, 'sampleCount': int(old.size),
            'meanSignedDifferenceM': float(delta.mean()), 'meanAbsoluteDifferenceM': float(absolute.mean()),
            'rootMeanSquaredDifferenceM': float(np.sqrt(np.mean(delta*delta))),
            'medianAbsoluteDifferenceM': float(np.median(absolute)),
            'p95AbsoluteDifferenceM': float(np.percentile(absolute, 95)),
            'p99AbsoluteDifferenceM': float(np.percentile(absolute, 99)),
            'maxAbsoluteDifferenceM': float(absolute.max()),
            'interpretation': 'Observed resampling differences, not an accuracy guarantee or a source survey validation.',
            'featureSamples': [{'feature': label, 'originalRow': row, 'originalColumn': col,
                               'longitude': float(bounds[0]+(bounds[2]-bounds[0])*col/128),
                               'latitude': float(bounds[3]-(bounds[3]-bounds[1])*row/128),
                               'originalHeightM': float(old[row, col]),
                               'refinedHeightM': float(aligned[row, col]),
                               'differenceM': float(delta[row, col])} for label, row, col in points]}


def build(root: Path, *, check_only: bool = False) -> dict:
    runtime = root / ARCHIVE
    before = snapshot(runtime)
    archive = TerrainArchive(runtime)
    original_path = root / PREVIEW if (root / PREVIEW).exists() else root / GRID
    original_bytes = original_path.read_bytes()
    original = json.loads(original_bytes)
    verified_original = json.loads((runtime / archive.manifest['gridPath']).read_bytes())
    if original.get('width') != PREVIEW_SIZE or original.get('height') != PREVIEW_SIZE:
        raise ValueError('Expected the original 129 by 129 preview; refusing to overwrite it')
    for key in ('width', 'height', 'bounds', 'units', 'rowOrder', 'columnOrder', 'coordinateGrid', 'elevations'):
        if original[key] != verified_original[key]:
            raise ValueError(f'Preview geometry differs from the manifest-verified original: {key}')

    west, south, east, north = archive.bounds.tolist()
    lons, lats = np.linspace(west, east, GRID_SIZE), np.linspace(north, south, GRID_SIZE)
    samples = archive.sample(lons[np.newaxis, :], lats[:, np.newaxis])
    numeric_checks = verify_sampling(archive, lons, lats, samples)
    values = np.round(samples, 1)
    roundoff = float(np.max(np.abs(values-samples)))
    if not np.isfinite(values).all() or roundoff > 0.05000001:
        raise ValueError('Invalid output samples or rounding error')
    manifest_sha = sha256(archive.manifest_bytes)
    spacing = {'eastWest': round((east-west)*111320*math.cos(math.radians((south+north)/2))/(GRID_SIZE-1), 2),
               'northSouth': round((north-south)*111320/(GRID_SIZE-1), 2)}
    source = copy.deepcopy(archive.manifest['source'])
    source.update({'upstreamUrlTemplate': source.pop('urlTemplate'),
                   'upstreamTileSize': source['sourceTileSize'], 'upstreamTileFormat': 'WEBP',
                   'sourceTileSize': TILE_SIZE, 'sourceTileFormat': 'PNG', 'sourceTileEncoding': 'terrarium',
                   'sampledArchivePath': (ARCHIVE / 'tiles/12/{x}/{y}.png').as_posix(),
                   'archiveManifestSha256': manifest_sha})
    grid = {'schemaVersion': 1, 'bounds': archive.bounds.tolist(), 'width': GRID_SIZE, 'height': GRID_SIZE,
            'elevations': values.reshape(-1).tolist(), 'minElevation': float(values.min()),
            'maxElevation': float(values.max()), 'units': 'meters', 'rowOrder': 'north-to-south',
            'columnOrder': 'west-to-east', 'coordinateGrid': 'regular-longitude-latitude',
            'interpolation': 'Bilinear on numeric metre heights decoded from archived Terrarium PNG256 at zoom 12, using WebMercator pixel centres and real neighbours across tile seams. Not directly sampled from original WEBP512; no generated or filled points.',
            'sampleSpacingApproxM': spacing, 'source': source,
            'processing': {'tool': 'tools/map-package/refine_terrain.py', 'version': 1,
                           'inputManifestPath': (ARCHIVE / 'manifest.json').as_posix(),
                           'inputManifestSha256': manifest_sha, 'inputTileCount': len(archive.tiles),
                           'archivedTileReduction': archive.manifest['processing']['tiles'],
                           'inputNumericEncodingPrecisionM': 1/256, 'outputRoundingM': 0.1,
                           'measurementAccuracyClaimedM': None, 'missingDataFilled': False,
                           'missingDataPolicy': 'Fail on missing tiles, unavailable neighbours, invalid values or hash mismatches; never clamp or fill.'},
            'attribution': archive.manifest['attribution'], 'liabilityNotice': archive.manifest['liabilityNotice'],
            'fieldVerified': False, 'navigationReady': False,
            'limitations': 'Denser display mesh from an existing resampled DSM archive, not a new survey or increased measurement accuracy. Nominal GLO-30 source resolution remains 30 m; output spacing is not accuracy. Does not establish trail passability, current snow, obstacles, avalanches or land-cover details.'}
    grid_bytes = json_bytes(grid)
    after = snapshot(runtime)
    if after != before:
        raise ValueError('Archive changed during refinement; no output was published')

    evidence = {'schemaVersion': 1, 'status': 'passed',
                'verifiedAt': datetime.now(timezone.utc).isoformat(),
                'command': 'python3 tools/map-package/refine_terrain.py',
                'scriptSha256': sha256(Path(__file__).read_bytes()),
                'inputManifest': {'path': (ARCHIVE / 'manifest.json').as_posix(),
                                  'sizeBytes': len(archive.manifest_bytes), 'sha256': manifest_sha},
                'manifestFilesVerified': len(archive.records),
                'inputTiles': [{'path': (ARCHIVE / item['path']).as_posix(), 'sizeBytes': item['sizeBytes'],
                                'sha256': item['sha256'], 'manifestVerified': True}
                               for item in archive.selected_records],
                'previewMatchesManifestGridGeometry': True,
                'previewMetadataNote': 'Original web preview bytes are preserved, including its earlier checkedAt timestamp. Its height samples and spatial metadata exactly match the manifest-verified original archive grid.',
                'outputs': [{'path': GRID.as_posix(), 'sizeBytes': len(grid_bytes), 'sha256': sha256(grid_bytes),
                             'dimensions': [GRID_SIZE, GRID_SIZE], 'samples': int(values.size)},
                            {'path': PREVIEW.as_posix(), 'sizeBytes': len(original_bytes),
                             'sha256': sha256(original_bytes), 'dimensions': [PREVIEW_SIZE, PREVIEW_SIZE],
                             'byteIdenticalToOriginalWebGrid': True}],
                'sampling': {'outputSampleSpacingApproxM': spacing, 'inputTileSize': TILE_SIZE,
                             'inputZoom': ZOOM, 'upstreamSourceNominalResolutionM': source['sourceNominalResolutionM'],
                             'outputRangeM': [float(values.min()), float(values.max())],
                             'noNetworkAccessUsed': True, 'generatedHeights': False, 'missingDataFilled': False,
                             'maxOutputRoundingErrorM': roundoff, **numeric_checks},
                'comparisonWithOriginalPreview': comparison(original, values, archive.bounds),
                'archivePreservation': {'unchanged': True, 'fileCount': len(before),
                                        'beforeTreeSha256': sha256(json_bytes(before)),
                                        'afterTreeSha256': sha256(json_bytes(after))}}
    # Packaging clients must verify actual derived bytes, not trust editable
    # provenance metadata or an earlier verification report alone.
    if check_only:
        for relative, expected in ((GRID, grid_bytes), (PREVIEW, original_bytes)):
            if (root / relative).read_bytes() != expected:
                raise ValueError(f'Derived terrain differs from the verified archive: {relative}')
    else:
        # Every check completes before any output replacement. The archive stays read-only.
        if not (root / PREVIEW).exists():
            atomic_write(root / PREVIEW, original_bytes)
        atomic_write(root / GRID, grid_bytes)
        atomic_write(root / EVIDENCE, json_bytes(evidence, pretty=True))
    if snapshot(runtime) != before:
        raise ValueError('Archive changed concurrently during output verification or publication')
    return {'status': evidence['status'], 'outputs': evidence['outputs'],
            'checkOnly': check_only, 'inputManifest': evidence['inputManifest'],
            'sampleSpacingApproxM': spacing, 'inputTilesVerified': len(archive.tiles),
            'archiveUnchanged': True, 'comparison': {
                key: evidence['comparisonWithOriginalPreview'][key]
                for key in ('meanAbsoluteDifferenceM', 'p95AbsoluteDifferenceM', 'maxAbsoluteDifferenceM')}}


def verify(root: Path) -> dict:
    """Recompute and compare the derived grid; never download or write files."""
    return build(root.resolve(), check_only=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2],
                        help='Project root; defaults to the checkout containing this script')
    parser.add_argument('--check', action='store_true',
                        help='Verify the derived grid against its archive without writing files')
    args = parser.parse_args()
    print(json.dumps(verify(args.root) if args.check else build(args.root.resolve()), ensure_ascii=False))


if __name__ == '__main__':
    main()
