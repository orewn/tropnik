#!/usr/bin/env python3
"""Apply the documented categorical palette to an explicitly selected package.

Height and class bytes remain immutable. Requires the caller's expected old
surface hash, records the edit, and publishes the new manifest last.
"""
import argparse
import io
import json
import re

import numpy as np
from PIL import Image

from build_region import (MATERIAL_PALETTE_VERSION, PALETTE, PUBLIC,
                         digest, encoded_json, now)
from verify_region import verify


def recolor(region_id, expected_surface_sha256):
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', region_id):
        raise ValueError('Invalid region id')
    verify(region_id)
    directory = PUBLIC / region_id
    manifest_path = PUBLIC / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    entry = next(region for region in manifest['regions'] if region['id'] == region_id)
    old_surface = (directory / 'surface.png').read_bytes()
    old_sha = digest(old_surface)
    if old_sha != expected_surface_sha256 or old_sha != entry['materialSha256']:
        raise ValueError('Surface differs from the explicitly expected revision')
    grid_bytes = (directory / 'terrain-grid.json').read_bytes()
    class_bytes = (directory / 'classes.png').read_bytes()
    grid_sha, class_sha = digest(grid_bytes), digest(class_bytes)
    provenance_path, coverage_path = directory / 'provenance.json', directory / 'coverage.json'
    provenance = json.loads(provenance_path.read_text())
    coverage = json.loads(coverage_path.read_text())
    if grid_sha != provenance['artifacts']['terrain-grid.json']['sha256'] or class_sha != provenance['artifacts']['classes.png']['sha256']:
        raise ValueError('Immutable measured input checksum differs')
    classes_image = Image.open(io.BytesIO(class_bytes))
    if classes_image.mode != 'L' or classes_image.size != (entry['material']['width'], entry['material']['height']):
        raise ValueError('Unexpected measured classification format')
    classes = np.array(classes_image)
    if not set(np.unique(classes)) <= set(PALETTE):
        raise ValueError('Unknown measured class; no synthetic replacement')
    rgba = np.zeros((*classes.shape, 4), dtype=np.uint8)
    for code, (label, color) in PALETTE.items():
        mask = classes == code
        record = coverage['classHistogram'][str(code)]
        if int(mask.sum()) != record['samples'] or record['class'] != label:
            raise ValueError('Measured classification histogram differs')
        rgba[mask] = color
        record['rgba'] = list(color)
    buffer = io.BytesIO()
    Image.fromarray(rgba).save(buffer, format='PNG', optimize=True)
    surface_bytes = buffer.getvalue()
    if len(surface_bytes) > 8 * 1024**2:
        raise ValueError('Material exceeds bounded runtime size')
    new_sha, changed_at = digest(surface_bytes), now()
    if new_sha == old_sha:
        raise ValueError('Palette already applied; no duplicate edit recorded')
    coverage['materialPaletteVersion'] = MATERIAL_PALETTE_VERSION
    provenance['materialPaletteVersion'] = MATERIAL_PALETTE_VERSION
    provenance.setdefault('postProcessing', []).append({
        'tool': 'tools/terrain-data/recolor_region.py', 'at': changed_at,
        'kind': 'categorical-palette-only', 'paletteVersion': MATERIAL_PALETTE_VERSION,
        'sourceClassesSha256': class_sha, 'preservedGridSha256': grid_sha,
        'previousSurfaceSha256': old_sha, 'surfaceSha256': new_sha,
        'pixelSha256': digest(rgba.tobytes()),
        'description': 'Exact integer WorldCover classes mapped to a lighter Tropnik RGBA palette. No blur, new classes, spatial resampling or elevation change.'})
    provenance['artifacts']['surface.png'] = {'sha256': new_sha, 'bytes': len(surface_bytes)}
    entry['materialSha256'], entry['materialBytes'] = new_sha, len(surface_bytes)
    entry['material']['paletteVersion'] = MATERIAL_PALETTE_VERSION
    entry['provenance']['materialUpdatedAt'] = changed_at
    outputs = {directory / 'surface.png': surface_bytes, coverage_path: encoded_json(coverage),
               provenance_path: encoded_json(provenance), manifest_path: encoded_json(manifest)}
    for path, data in outputs.items():
        temporary = path.with_name(path.name + '.palette-partial')
        temporary.write_bytes(data)
    # The manifest is last: readers never accept a new surface under an old hash.
    for path in outputs:
        path.with_name(path.name + '.palette-partial').replace(path)
    if (directory / 'terrain-grid.json').read_bytes() != grid_bytes or (directory / 'classes.png').read_bytes() != class_bytes:
        raise RuntimeError('Immutable measured inputs changed during recoloring')
    verify(region_id)
    return {'id': region_id, 'paletteVersion': MATERIAL_PALETTE_VERSION,
            'surfaceSha256': new_sha, 'surfaceBytes': len(surface_bytes),
            'pixelSha256': digest(rgba.tobytes()), 'unchangedGridSha256': grid_sha,
            'unchangedClassesSha256': class_sha}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('id')
    parser.add_argument('--expected-surface-sha256', required=True)
    args = parser.parse_args()
    print(json.dumps(recolor(args.id, args.expected_surface_sha256), indent=2))
