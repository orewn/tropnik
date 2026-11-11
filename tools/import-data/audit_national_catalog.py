#!/usr/bin/env python3
"""Verify the national supplement against every preserved upstream response."""
from collections import Counter
from datetime import datetime, timezone
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile

from shapely.geometry import shape, MultiLineString
from shapely.ops import transform, unary_union
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/catalog/national'
spec = importlib.util.spec_from_file_location('waymarked', Path(__file__).with_name('import_waymarked.py'))
wmt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wmt)


def read(path):
    return json.loads(path.read_text())


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def audit(raw_root=OUT, check_only=False):
    discovery = read(OUT / 'discovery.json')
    report = read(OUT / 'import-report.json')
    records = read(OUT / 'routes.json')['routes']
    features = read(OUT / 'routes.geojson')['features']
    failures = []
    def check(condition, message):
        if not condition:
            failures.append(message)
    check(report['discoverySha256'] == sha(OUT / 'discovery.json'), 'Discovery identity changed')
    check(report['baseCatalogSha256'] == sha(ROOT / 'data/catalog/routes.json'), 'Base catalog identity changed')
    for source in (report['boundarySource'], report['displayCoverageSource']):
        check(sha(ROOT / source['path']) == source['sha256'], 'Boundary source identity changed: ' + source['path'])
    source_paths = set()
    for source in discovery['rawSources'] + report['rawSources']:
        path = raw_root / source['path']
        check(path.is_relative_to(raw_root) and '..' not in Path(source['path']).parts, 'Unsafe source path')
        check(path.is_file() and path.stat().st_size == source['bytes'] and sha(path) == source['sha256'], 'Source hash/size mismatch: ' + source['path'])
        source_paths.add(source['path'])
    known = {r['osmId'] for r in read(ROOT / 'data/catalog/routes.json')['routes']}
    ids = [r['osmId'] for r in records]
    check(len(ids) == len(set(ids)), 'Duplicate supplement OSM IDs')
    check(not set(ids) & known, 'Supplement duplicates the previous catalog')
    check(len(features) == len(records) == report['acceptedRouteCount'], 'Route counts disagree')
    feature_ids = [f['properties']['osmId'] for f in features]
    check(feature_ids == ids, 'Feature/card order or identities disagree')
    declared_candidates = {r['osmId'] for r in discovery['candidates']}
    actual_candidates = {r['id'] for source in discovery['rawSources']
                         for r in read(raw_root / source['path']).get('results', []) if r.get('type') == 'relation'}
    check(declared_candidates == actual_candidates, 'Discovery omitted or invented a candidate')
    accounted = set(ids) | {r['osmId'] for r in report['rejected']} | {r['osmId'] for r in report['requestFailures']} | set(report['detailsExcludedByGlobalBound'])
    check(accounted == declared_candidates - known, 'Not every new candidate is accounted for')
    area = prep(unary_union([shape(f['geometry']) for f in read(ROOT / report['displayCoverageSource']['path'])['features']]))
    territories = {f['properties']['territoryId']: shape(f['geometry']) for f in read(ROOT / report['boundarySource']['path'])['features']}
    check(set(territories) == set(discovery['regions']) == set(report['regions']), 'Territory coverage report incomplete')
    point_count = 0
    geometry_bytes = 0
    counts = Counter()
    for record, feature in zip(records, features):
        ident = record['id']
        individual = OUT / record['geometryPath']
        check(read(individual) == {'type':'FeatureCollection', 'features':[feature]}, 'Individual/combined geometry mismatch: ' + ident)
        raw = raw_root / record['sourceRawPath']
        check(sha(raw) == record['sourceRawSha256'], 'Route/raw source mismatch: ' + ident)
        upstream = read(raw)
        check(upstream.get('id') == record['osmId'], 'Wrong source relation: ' + ident)
        original = []
        wmt.segments(upstream.get('route'), original, set())
        lines = [segment['coordinates'] for segment in original]
        check(feature['geometry'] == {'type':'MultiLineString', 'coordinates':lines}, 'Source member geometry altered: ' + ident)
        check(record['osmWayIds'] == [segment['wayId'] for segment in original], 'Source member identities changed: ' + ident)
        geometry = MultiLineString(lines)
        display_geometry = transform(lambda x,y,z=None:(x+360 if x<0 else x,y), geometry)
        check(area.covers(display_geometry), 'A route leaves the display polygon: ' + ident)
        memberships = [tid for tid, territory in territories.items() if territory.intersects(display_geometry)]
        check(memberships == record['territoryIds'] and bool(memberships), 'Incorrect territory membership: ' + ident)
        counts.update(memberships)
        points = sum(map(len, lines))
        point_count += points
        geometry_bytes += individual.stat().st_size
        check(points == record['pointCount'], 'Point count mismatch: ' + ident)
        check(record['geometryLengthKm'] == wmt.length_km(lines), 'Geometry length changed: ' + ident)
        check(record['publicationStatus'] == 'reference' and record['verificationStatus'] == 'source_only', 'Unjustified publication claim: ' + ident)
        check(not any(record.get(k) for k in ('fieldVerified','navigationReady','accessPermissionVerified','indexable')), 'Unjustified verification claim: ' + ident)
        check(all(record.get(k) is None for k in ('officialDistanceKm','difficulty','conditions','elevationGainM')), 'Unjustified route facts: ' + ident)
    check(point_count == report['geometryVertices'], 'Global vertex count mismatch')
    for tid, stat in report['regions'].items():
        check(stat['newRoutes'] == counts[tid], 'Wrong regional count: ' + tid)
    result = {'schemaVersion':1, 'auditedAt':datetime.now(timezone.utc).isoformat(), 'status':'passed' if not failures else 'failed',
              'scope':'Reproducible source, geometry and coverage integrity; not current-access, field or navigation certification.',
              'routeCount':len(records), 'newGeometryVertices':point_count, 'geometryBytes':geometry_bytes,
              'metadataBytes':(OUT / 'routes.json').stat().st_size, 'rawSourcesChecked':len(source_paths),
              'territoriesQueried':len(territories), 'territoriesWithNewGeometry':len(counts),
              'zeroNewGeometryTerritories':[{'id':tid,'name':report['regions'][tid]['name']} for tid in territories if not counts[tid]],
              'sourceQueryFailures':sum(len(s['errors']) for s in discovery['regions'].values()),
              'sourceDetailFailures':len(report['requestFailures']), 'unqueriedSubareas':sum(len(s['unqueriedSubareas']) for s in discovery['regions'].values()),
              'saturatedLeafExtents':sum(len(s['saturatedLeafExtents']) for s in discovery['regions'].values()),
              'omittedByDetailLimit':len(report['detailsExcludedByGlobalBound']),
              'limitedCandidateDetails':[r for r in report['requestFailures'] if r['error']=='Response exceeded 12 MB bound'],
              'sourceResponseLimitBytes':discovery['limits']['responseBytes'],
              'completenessClaim':False,
              'limitations':['The snapshot enumerates bounded provider-indexed relations, not all physical hiking paths.',
                             'A response exceeding the retained 12 MB limit is not retried and does not justify raising the acquisition bound.',
                             'Foreign or boundary-resolution candidates are not clipped or moved into the catalogue.'],
              'catalogSha256':sha(OUT / 'routes.json'), 'geometrySha256':sha(OUT / 'routes.geojson'),
              'reportSha256':sha(OUT / 'import-report.json'),
              'sourceArchiveUsed':raw_root != OUT, 'failures':failures}
    receipt_path = OUT / 'catalog-audit.json'
    if check_only:
        recorded = read(receipt_path)
        stable = lambda value:{k:v for k,v in value.items() if k not in ('auditedAt','sourceArchiveUsed')}
        if stable(recorded) != stable(result):
            raise ValueError('Dated national audit receipt is stale')
    else:
        receipt_path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='zeroNewGeometryTerritories'},ensure_ascii=False))
    if failures:
        raise SystemExit(1)


def unpack_source_archive(path, destination):
    receipt = read(OUT / 'source-archive.json')
    if path.stat().st_size != receipt['bytes'] or sha(path) != receipt['sha256']:
        raise ValueError('Source archive SHA256/size differs from the repository receipt')
    with tarfile.open(path, 'r:gz') as archive:
        members = archive.getmembers()
        if len(members) != receipt['sourceFiles'] + 1 or len({m.name for m in members}) != len(members):
            raise ValueError('Archive contains missing, duplicate or extra members')
        manifest_member = archive.getmember('source-snapshot.json')
        if not manifest_member.isfile() or manifest_member.size > 2_000_000:
            raise ValueError('Invalid source archive manifest')
        manifest_bytes = archive.extractfile(manifest_member).read(2_000_001)
        if hashlib.sha256(manifest_bytes).hexdigest() != receipt['manifestSha256']:
            raise ValueError('Source archive manifest mismatch')
        manifest = json.loads(manifest_bytes)
        if manifest['discoverySha256'] != sha(OUT / 'discovery.json') or manifest['importReportSha256'] != sha(OUT / 'import-report.json'):
            raise ValueError('Source archive describes another import')
        expected = {r['path']: r for r in manifest['files']}
        if len(expected) != receipt['sourceFiles'] or set(expected) != {m.name for m in members if m.name != 'source-snapshot.json'}:
            raise ValueError('Source archive inventory mismatch')
        for member in members:
            if member.name == 'source-snapshot.json':
                continue
            relative = Path(member.name)
            if (not member.isfile() or relative.is_absolute() or '..' in relative.parts or relative.parts[0] != 'raw'
                    or member.name != relative.as_posix() or '\\' in member.name or ':' in member.name):
                raise ValueError('Unsafe source archive member')
            record = expected[member.name]
            if member.size != record['bytes'] or member.size > 12_000_000:
                raise ValueError('Source archive member size mismatch')
            data = archive.extractfile(member).read(record['bytes'] + 1)
            if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
                raise ValueError('Source archive member hash mismatch')
            output = destination / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(data)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, help='Read the complete hash-pinned source archive instead of a local raw cache')
    parser.add_argument('--check', action='store_true', help='Verify without replacing the dated audit receipt')
    args = parser.parse_args()
    if args.archive:
        with tempfile.TemporaryDirectory(prefix='tropnik-national-sources-') as directory:
            temporary = Path(directory)
            unpack_source_archive(args.archive, temporary)
            audit(temporary, args.check)
    else:
        audit(check_only=args.check)
