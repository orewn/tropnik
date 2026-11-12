#!/usr/bin/env python3
"""Validate the delivered public terrain package independently of its builder."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'web/public/terrain-regions'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verify(region_id):
    manifest = json.loads((PUBLIC / 'manifest.json').read_text())
    assert manifest['schemaVersion'] == 1
    assert 0 < len(manifest['regions']) <= 128
    matches = [r for r in manifest['regions'] if r['id'] == region_id]
    assert len(matches) == 1, 'Region must have exactly one manifest entry'
    entry = matches[0]
    directory = PUBLIC / region_id
    grid_data = (directory / 'terrain-grid.json').read_bytes()
    surface_data = (directory / 'surface.png').read_bytes()
    assert entry['gridSha256'] == sha(grid_data)
    assert entry['materialSha256'] == sha(surface_data)
    assert entry['gridBytes'] == len(grid_data) <= 8 * 1024**2
    assert entry['materialBytes'] == len(surface_data) <= 8 * 1024**2
    grid = json.loads(grid_data)
    coverage = json.loads((directory / 'coverage.json').read_text())
    provenance = json.loads((directory / 'provenance.json').read_text())
    assert entry['bounds'] == grid['bounds'] == entry['material']['bounds'] == coverage['bounds'] == provenance['bounds']
    assert grid['source']['sourceNominalResolutionM'] == 30
    assert grid['source']['verticalDatum'] == 'EGM2008 orthometric metres'
    assert grid['processing']['sourceNativePixelCentresPreserved'] is False
    assert grid['processing']['missingDataFilled'] is False
    assert grid['processing']['measurementAccuracyClaimedM'] is None
    assert grid['fieldVerified'] is False and grid['navigationReady'] is False
    assert grid['sampleLayout'] == entry['material']['sampleLayout'] == 'grid-nodes'
    assert grid['rowOrder'] == entry['material']['rowOrder'] == 'north-to-south'
    assert grid['columnOrder'] == entry['material']['columnOrder'] == 'west-to-east'
    values = np.asarray(grid['elevations'], dtype=float).reshape(grid['height'], grid['width'])
    assert values.size <= 1_050_625 and np.isfinite(values).all()
    assert -12000 <= values.min() == grid['minElevation'] <= values.max() == grid['maxElevation'] <= 10000
    assert coverage['terrainValidSamples'] == coverage['terrainTotalSamples'] == values.size
    surface_image = Image.open(directory / 'surface.png')
    class_image = Image.open(directory / 'classes.png')
    assert surface_image.mode == 'RGBA' and class_image.mode == 'L'
    mw, mh = surface_image.size
    assert 2 <= mw <= 2048 and 2 <= mh <= 2048
    assert [mw, mh] == coverage['material']
    assert mw == entry['material']['width'] and mh == entry['material']['height']
    assert class_image.size == surface_image.size
    surface, classes = np.array(surface_image), np.array(class_image)
    assert np.all(surface[:, :, 3] == 255), 'No uncovered or implicit land pixels'
    valid_codes = {10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100}
    assert set(np.unique(classes)) <= valid_codes
    assert coverage['materialValidSamples'] == coverage['materialTotalSamples'] == classes.size
    for code in valid_codes:
        mask = classes == code
        record = coverage['classHistogram'][str(code)]
        assert record['samples'] == int(mask.sum())
        assert np.all(surface[mask] == record['rgba']), f'Material differs from its documented class {code}'
    for filename, record in provenance['artifacts'].items():
        data = (directory / filename).read_bytes()
        assert sha(data) == record['sha256'] and len(data) == record['bytes']
    if 'materialPaletteVersion' in provenance:
        assert provenance['materialPaletteVersion'] == coverage['materialPaletteVersion'] == entry['material']['paletteVersion']
    if provenance.get('postProcessing'):
        latest = provenance['postProcessing'][-1]
        assert latest['kind'] == 'categorical-palette-only'
        assert latest['preservedGridSha256'] == entry['gridSha256']
        assert latest['sourceClassesSha256'] == sha((directory / 'classes.png').read_bytes())
        assert latest['surfaceSha256'] == entry['materialSha256']
        assert latest['pixelSha256'] == sha(surface.tobytes())
    assert len(provenance['sources']) <= 12
    assert provenance['totalRangeReadBytes'] <= provenance['command']['maxDownloadMiB'] * 1024**2
    assert provenance['rangeRequestCount'] <= 192
    for source in provenance['sources']:
        assert source['url'].startswith(('https://copernicus-dem-30m.s3.amazonaws.com/',
                                         'https://esa-worldcover.s3.eu-central-1.amazonaws.com/'))
        assert source['sourceObjectSha256'] is None, 'Partial source must not claim full-object hash'
        assert source['httpHeaders']['etag']
        assert source['ranges']
        for record in source['ranges']:
            assert 0 <= record['start'] <= record['endInclusive'] < source['objectSizeBytes']
            assert record['bytes'] == record['endInclusive'] - record['start'] + 1 <= 8 * 1024**2
            assert len(record['sha256']) == 64 and int(record['sha256'], 16) >= 0
    west, south, east, north = grid['bounds']
    corners = {'northWest': [west, north, float(values[0, 0])],
               'northEast': [east, north, float(values[0, -1])],
               'southWest': [west, south, float(values[-1, 0])],
               'southEast': [east, south, float(values[-1, -1])]}
    return {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'id': region_id,
            'status': 'passed', 'grid': [grid['width'], grid['height']],
            'material': [mw, mh], 'elevationRangeM': [float(values.min()), float(values.max())],
            'cornerNodes': corners, 'materialClasses': sorted(int(c) for c in np.unique(classes)),
            'gridBytes': len(grid_data), 'materialBytes': len(surface_data),
            'sourceRangeBytes': provenance['totalRangeReadBytes'],
            'scope': 'Artifact integrity, coordinate conventions, finite measured coverage, documented category colours and bounded provenance. Not field validation or a frame-rate test.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('id')
    args = parser.parse_args()
    print(json.dumps(verify(args.id), ensure_ascii=False, indent=2))
