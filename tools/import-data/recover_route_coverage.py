#!/usr/bin/env python3
"""Recheck old coarse-mask rejections against the unchanged pinned full source.

Fresh HTTP responses are a separate, resumable acquisition. Historical national
records and their retrieval dates are never rewritten. Only complete source
lines covered by the full selected source become new reference records.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import tarfile
import tempfile

import shapely
from shapely.geometry import MultiLineString, Point, Polygon, shape
from shapely.ops import unary_union
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / 'data/catalog/national/import-report.json'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


NATIONAL = module('national_recovery_input', Path(__file__).with_name('import_national_waymarked.py'))
BOUNDARY = module('recovery_boundary_input', ROOT / 'tools/map-package/build-russia-mask.py')


def sha(body):
    return hashlib.sha256(body).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',', ':')) + '\n').encode()


def read(path):
    return json.loads(path.read_bytes())


def selected_ids():
    return sorted(row['osmId'] for row in read(BASELINE)['rejected']
                  if row['reason'] == 'not_wholly_inside_existing_display_coverage')


def acquire(directory):
    NATIONAL.OUT = directory
    NATIONAL.UA = 'Tropnik-route-catalog/0.4.30 (https://github.com/orewn/tropnik)'
    identifiers = selected_ids()
    previous = directory / 'acquisition.json'
    old = read(previous) if previous.exists() else None
    baseline_sha = sha(BASELINE.read_bytes())
    if old and (old['baselineImportReportSha256'] != baseline_sha or old['selectedCandidates'] != identifiers):
        raise ValueError('The resumable acquisition belongs to a different baseline')
    if old and old.get('complete') and not old.get('errors'):
        checked_sources(directory, old)
        print(json.dumps({'completed': len(old['sources']), 'total': len(identifiers), 'errors': 0, 'retainedCompleteAcquisition': True}), flush=True)
        return
    report = {'schemaVersion': 1, 'createdAt': old['createdAt'] if old else NATIONAL.now(),
              'baselineImportReportSha256': baseline_sha, 'selectedCandidates': identifiers,
              'workers': 2, 'requestTimeoutSeconds': 35, 'maxResponseBytes': 12000000,
              'sources': [], 'errors': [], 'complete': False}
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = {pool.submit(NATIONAL.get_detail, ident): ident for ident in identifiers}
        for future in as_completed(jobs):
            ident = jobs[future]
            try:
                _, _, source = future.result()
                report['sources'].append({'osmId': ident, **source})
            except Exception as error:
                report['errors'].append({'osmId': ident, 'error': str(error)})
            NATIONAL.save(previous, report)
            completed = len(report['sources']) + len(report['errors'])
            if completed % 10 == 0:
                print(json.dumps({'completed': completed, 'total': len(identifiers), 'errors': len(report['errors'])}), flush=True)
    report['sources'].sort(key=lambda item: item['osmId'])
    report['errors'].sort(key=lambda item: item['osmId'])
    report['complete'] = True
    report['completedAt'] = NATIONAL.now()
    NATIONAL.save(previous, report)


def full_source(source_directory, download_missing=False):
    original = BOUNDARY.RAW
    BOUNDARY.RAW = source_directory
    features, receipts = [], []
    try:
        for iso in ['RUS', 'UKR']:
            path, document, _ = BOUNDARY.load_source(iso, download_missing)
            chosen = document['features'] if iso == 'RUS' else [feature for feature in document['features']
                      if feature['properties']['shapeName'] in BOUNDARY.CRIMEA_NAMES]
            features.extend({'id': 'territory-' + feature['properties']['shapeID'],
                             'shapeName': feature['properties']['shapeName'],
                             'shape': BOUNDARY.unwrap(shape(feature['geometry']))} for feature in chosen)
            receipts.append({'iso': iso, 'sha256': sha(path.read_bytes()), 'bytes': path.stat().st_size,
                             'selectedFeatureCount': len(chosen)})
    finally:
        BOUNDARY.RAW = original
    raw = BOUNDARY.polygonal(unary_union([feature['shape'] for feature in features]))
    holes = [Polygon(ring) for polygon in BOUNDARY.polygons(raw) for ring in polygon.interiors]
    lakes = []
    for coordinate in [(31.5, 60.8), (35.5, 61.8)]:
        matches = [hole for hole in holes if hole.covers(Point(coordinate))]
        if len(matches) != 1:
            raise ValueError('Historical inland-water display selection changed')
        lakes.extend(matches)
    return BOUNDARY.polygonal(unary_union([raw, *lakes])), {
        'sourceCommit': BOUNDARY.COMMIT, 'sources': receipts,
        'selectedFeatures': 85, 'inlandWaterInclusions': ['Lake Ladoga', 'Lake Onega'],
        'predicate': 'full-source covers whole unsimplified route geometry',
        'bufferApplied': False, 'clippedRoutes': False, 'territorialSelectionChanged': False,
    }, features


def source_territories(regions, source_features):
    """Keep reviewed identities while using their unchanged full source shapes.

    A coarse territory outline can exclude the same coastal line as the old
    country mask. Membership must use the original polygon as well; a nearby
    or approximately named territory is never substituted.
    """
    originals = {feature['id']: feature for feature in source_features}
    if len(originals) != len(source_features) or set(originals) != {region['id'] for region in regions}:
        raise ValueError('Full-source territory identities differ from the existing display selection')
    result = []
    for region in regions:
        original = originals[region['id']]
        if region['shapeNames'] != [original['shapeName']]:
            raise ValueError('Full-source territory name differs from its reviewed identity')
        result.append({**region, 'shape': original['shape']})
    return result


def checked_sources(raw_root, acquisition):
    if not acquisition.get('complete') or acquisition['selectedCandidates'] != selected_ids():
        raise ValueError('Acquisition is incomplete or belongs to different candidate identities')
    if acquisition['baselineImportReportSha256'] != sha(BASELINE.read_bytes()):
        raise ValueError('Historical rejection report changed')
    accounted = [record['osmId'] for record in acquisition['sources']] + [record['osmId'] for record in acquisition['errors']]
    if len(accounted) != len(set(accounted)) or set(accounted) != set(selected_ids()):
        raise ValueError('Candidate accounting is incomplete or duplicated')
    result = []
    for record in acquisition['sources']:
        ident = record['osmId']
        relative = Path(f'raw/relations/{ident}.json')
        if record['path'] != relative.as_posix() or record['sourceUrl'] != NATIONAL.BASE + f'/details/relation/{ident}':
            raise ValueError('Source identity/path mismatch')
        body = (raw_root / relative).read_bytes()
        sidecar = read((raw_root / relative).with_suffix('.json.source.json'))
        if len(body) != record['bytes'] or sha(body) != record['sha256'] or any(sidecar.get(key) != value for key, value in record.items() if key not in ('osmId', 'path')):
            raise ValueError('Fresh response or acquisition sidecar changed')
        result.append((record, json.loads(body)))
    return result


def source_archive(raw_root, acquisition):
    output = io.BytesIO()
    files = {'acquisition.json': encoded(acquisition)}
    for source in acquisition['sources']:
        path = Path(source['path'])
        files[path.as_posix()] = (raw_root / path).read_bytes()
        sidecar = path.with_suffix('.json.source.json')
        files[sidecar.as_posix()] = (raw_root / sidecar).read_bytes()
    with gzip.GzipFile(filename='', fileobj=output, mode='wb', mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
            for name, body in sorted(files.items()):
                entry = tarfile.TarInfo(name); entry.size = len(body); entry.mtime = 0; entry.mode = 0o644
                archive.addfile(entry, io.BytesIO(body))
    return output.getvalue(), len(files)


def build(raw_root, source_directory, destination, check=False, download_missing=False):
    acquisition = read(raw_root / 'acquisition.json')
    responses = checked_sources(raw_root, acquisition)
    print('Checking whole lines against the pinned full-resolution source...', flush=True)
    display, source_provenance, source_features = full_source(source_directory, download_missing)
    prepared = prep(display)
    regions, territory_source = NATIONAL.territories()
    regions = source_territories(regions, source_features)
    territory_source = {'identitySource': territory_source, 'geometrySource': 'The same pinned full-resolution ADM1 polygons as sourceCoverage',
                        'membershipPredicate': 'full-source territory intersects whole source route', 'territoryCount': len(regions)}
    coarse = prep(unary_union([shape(feature['geometry']) for feature in read(ROOT / 'web/public/data/russia-display-area.geojson')['features']]))
    features, rejected, checks = [], [], []
    for source, data in responses:
        ident = source['osmId']
        try:
            feature, reason = NATIONAL.normalize(ident, data, source, regions, prepared)
        except ValueError as error:
            feature, reason = None, 'invalid_source_geometry: ' + str(error)
        row = {'osmId': ident, 'title': data.get('name'), 'sourceSha256': source['sha256'], 'accepted': feature is not None}
        if feature:
            geometry = BOUNDARY.unwrap(shape(feature['geometry']))
            if not display.covers(geometry):
                raise AssertionError('Whole-line admission must not be weakened')
            row.update({'fullSourceCoversWholeGeometry': True,
                        'legacyCoarseCoversWholeGeometry': coarse.covers(geometry),
                        'parts': feature['properties']['segmentCount'], 'vertices': feature['properties']['pointCount']})
            features.append(feature)
        else:
            row['reason'] = reason
            if reason == 'not_wholly_inside_existing_display_coverage':
                _, lines = NATIONAL.normalized_lines(data)
                geometry = BOUNDARY.unwrap(MultiLineString(lines))
                points = shapely.get_coordinates(geometry)
                row.update({'fullSourceCoversWholeGeometry': False,
                            'verticesOutsideFullSource': int((~shapely.intersects_xy(display, points[:, 0], points[:, 1])).sum()),
                            'intersectsFullSource': display.intersects(geometry)})
            rejected.append(row)
        checks.append(row)
    features.sort(key=lambda item: item['properties']['osmId'])
    files, cards = {}, []
    for feature in features:
        properties = dict(feature['properties'])
        relative = 'geometry/' + properties['id'] + '.geojson'
        files[relative] = encoded({'type': 'FeatureCollection', 'features': [feature]})
        cards.append({**properties, 'geometryPath': relative})
    files['routes.json'] = encoded({'schemaVersion': 1, 'createdAt': acquisition['completedAt'], 'routes': cards})
    files['routes.geojson'] = encoded({'type': 'FeatureCollection', 'name': 'Full-source coverage recovery of coarse-mask exclusions',
                                     'license': 'ODbL-1.0', 'attribution': '© OpenStreetMap contributors', 'features': features})
    archive, archive_files = source_archive(raw_root, acquisition)
    files['source-responses.tar.gz'] = archive
    files['acquisition.json'] = encoded(acquisition)
    report = {'schemaVersion': 1, 'baselineImportReportSha256': acquisition['baselineImportReportSha256'],
              'generatorEnvironment': {'shapely': shapely.__version__, 'geos': shapely.geos_version_string, 'numpy': BOUNDARY.np.__version__},
              'sourceCoverage': source_provenance, 'territories': territory_source,
              'acquisitionStartedAt': acquisition['createdAt'], 'acquisitionCompletedAt': acquisition['completedAt'],
              'candidates': len(acquisition['selectedCandidates']), 'sourceResponses': len(responses),
              'sourceFailures': acquisition['errors'], 'acceptedRouteCount': len(features),
              'rejectedRouteCount': len(rejected), 'geometryVertices': sum(row['pointCount'] for row in cards),
              'legacyCoarseMaskSha256': sha((ROOT / 'web/public/data/russia-display-area.geojson').read_bytes()),
              'sourceArchive': {'path': 'source-responses.tar.gz', 'bytes': len(archive), 'sha256': sha(archive), 'files': archive_files},
              'catalogSha256': sha(files['routes.json']), 'geometrySha256': sha(files['routes.geojson']),
              'coordinateChanges': 'Mercator to WGS84 and seven decimal places only; original segments and their order retained.',
              'navigationReady': False, 'fieldVerified': False, 'completenessClaim': False,
              'checks': checks}
    files['recovery-report.json'] = encoded(report)
    files['ATTRIBUTION.txt'] = b'OSM-derived route data: OpenStreetMap contributors, distributed by Waymarked Trails. ODbL 1.0.\nhttps://www.openstreetmap.org/copyright\nhttps://opendatacommons.org/licenses/odbl/1-0/\nFresh source responses and dates are retained; no field, access, or navigation verification is claimed.\n'
    for relative, body in files.items():
        path = destination / relative
        if check:
            if not path.exists() or path.read_bytes() != body:
                raise ValueError('Recovery output differs from its pinned inputs: ' + relative)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
    geometry_paths = {name for name in files if name.startswith('geometry/')}
    actual_geometry = {str(path.relative_to(destination)) for path in (destination / 'geometry').glob('*.geojson')}
    if actual_geometry != geometry_paths:
        raise ValueError('Unexpected stale recovery geometry remains in the output')
    print(json.dumps({key: report[key] for key in ['candidates', 'sourceResponses', 'sourceFailures', 'acceptedRouteCount', 'rejectedRouteCount', 'geometryVertices', 'sourceArchive']}, ensure_ascii=False), flush=True)


def unpack_archive(path, destination, receipt):
    body = path.read_bytes()
    if len(body) != receipt['bytes'] or sha(body) != receipt['sha256']:
        raise ValueError('Recovery source archive differs from the committed receipt')
    with tarfile.open(fileobj=io.BytesIO(body), mode='r:gz') as archive:
        members = archive.getmembers()
        if len(members) != receipt['files'] or len({member.name for member in members}) != len(members):
            raise ValueError('Source archive inventory differs from receipt')
        total = 0
        for member in members:
            allowed = member.name == 'acquisition.json' or re.fullmatch(r'raw/relations/[0-9]+\.json(?:\.source\.json)?', member.name)
            total += member.size
            if not allowed or not member.isfile() or member.size > 12000000 or total > 100000000:
                raise ValueError('Unsafe or excessive source archive member')
            contents = archive.extractfile(member).read(member.size + 1)
            if len(contents) != member.size:
                raise ValueError('Truncated source archive member')
            output = destination / member.name
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(contents)
    checked_sources(destination, read(destination / 'acquisition.json'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['acquire', 'build'])
    parser.add_argument('--raw-root', type=Path)
    parser.add_argument('--archive', type=Path, help='Reproduce without a retained raw cache using the committed source archive')
    parser.add_argument('--source-dir', type=Path, default=ROOT / 'data/boundaries/raw')
    parser.add_argument('--download-missing', '--download-sources', action='store_true', help='Fetch missing boundary inputs at the existing pinned commit; exact hashes remain mandatory')
    parser.add_argument('--output', type=Path, default=ROOT / 'data/catalog/coverage-recovery')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.phase == 'acquire':
        if args.check or args.archive or args.download_missing or not args.raw_root:
            parser.error('Acquisition requires --raw-root and does not accept --archive, --download-missing or --check')
        acquire(args.raw_root)
    elif args.archive:
        if args.raw_root:
            parser.error('Choose either --archive or --raw-root')
        with tempfile.TemporaryDirectory(prefix='tropnik-coverage-recovery-') as directory:
            temporary = Path(directory)
            unpack_archive(args.archive, temporary, read(args.output / 'recovery-report.json')['sourceArchive'])
            build(temporary, args.source_dir, args.output, args.check, args.download_missing)
    else:
        if not args.raw_root:
            parser.error('Build requires --raw-root or --archive')
        build(args.raw_root, args.source_dir, args.output, args.check, args.download_missing)


if __name__ == '__main__':
    main()
