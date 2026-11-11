"""Retain all reviewed vector data while retiring renderer-specific PBF glyphs."""
from __future__ import annotations

import copy
import json
from asset_integrity import digest, require, safe_relative

SOURCE_MANIFEST = 'source-manifest.json'


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode()


def retained_path(path):
    safe_relative(path)
    return not path.startswith('fonts/')


def package_from_source(source_bytes, read):
    source = json.loads(source_bytes)
    require(source.get('complete') is True and source.get('tileCount') == 193,
            'Original pilot vector archive is incomplete')
    records = source.get('files', [])
    require(isinstance(records, list) and len(records) == len({safe_relative(r.get('path')) for r in records}),
            'Invalid pilot source file list')
    files = {SOURCE_MANIFEST: source_bytes}
    kept = []
    for record in records:
        path = safe_relative(record['path'])
        if not retained_path(path):
            continue
        data = read(path)
        require(len(data) == record.get('bytes') and digest(data) == record.get('sha256'), 'Pilot source asset changed: ' + path)
        files[path] = data; kept.append(copy.deepcopy(record))
    tiles = [r for r in kept if r['path'].startswith('localtiles/') and r['path'].endswith('.pbf')]
    require(len(tiles) == 193 and all(r['path'] in files for r in tiles), 'Pilot source tile inventory differs')
    manifest = copy.deepcopy(source)
    for key in ('glyphRangesExpected', 'fontstack', 'localGlyphs', 'packageBytesIncludingManifest'):
        manifest.pop(key, None)
    manifest.update(runtime='tropnik-canvas', sourceArchive={'manifestPath': SOURCE_MANIFEST, 'sha256': digest(source_bytes)},
                    files=kept + [{'path': SOURCE_MANIFEST, 'bytes': len(source_bytes), 'sha256': digest(source_bytes)}])
    manifest['ipRights'] = [item for item in manifest.get('ipRights', []) if 'glyph' not in item.get('component', '').lower()]
    manifest['limitations'] = [item for item in manifest.get('limitations', []) if 'glyph' not in item.lower() and 'style' not in item.lower()]
    manifest['limitations'].append('Rendered by the shared Tropnik Canvas engine with bundled Manrope text, without provider styles, sprites or glyph PBFs.')
    manifest['resourceBytes'] = sum(record['bytes'] for record in manifest['files'])
    manifest['totalFiles'] = len(manifest['files'])
    files['manifest.json'] = json_bytes(manifest)
    return files


def verify_pilot(manifest_bytes, read, *, actual_files=None):
    manifest = json.loads(manifest_bytes)
    source = read(SOURCE_MANIFEST)
    expected = package_from_source(source, read)
    require(expected['manifest.json'] == manifest_bytes, 'Pilot runtime manifest differs from source data')
    if actual_files is not None:
        require(set(actual_files) == set(expected), 'Unlisted or missing pilot asset')
    require(not any(path.startswith('fonts/') for path in expected), 'Legacy glyph runtime is packaged')
    return {'offlineTileCount': 193, 'manifestFilesVerified': len(manifest['files']),
            'manifestBytesVerified': manifest['resourceBytes'], 'offlineVectorSourceManifestSha256': digest(source),
            'offlineMapVendorGlyphsPackaged': False}
