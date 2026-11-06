#!/usr/bin/env python3
"""Check delivered source integrity, coverage totals and verification flags."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/catalog'


def load(relative):
    return json.loads((OUT / relative).read_text())


def file_hash(path):
    value = hashlib.sha256()
    with path.open('rb') as handle:
        while chunk := handle.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def main():
    report = load('waymarked-import-report.json')
    catalog = load('routes.json')
    geometry = load('routes.geojson')
    geofabrik = load('geofabrik-import-report.json')
    evidence = load('verification-evidence.json')
    failures = []
    checks = 0
    ids = [r['id'] for r in catalog['routes']]
    if len(ids) != len(set(ids)):
        failures.append('Duplicate route id')
    if len(ids) != report['routeCount'] or len(geometry['features']) != len(ids):
        failures.append('Route/geometry/report counts disagree')
    for row in catalog['routes']:
        checks += 1
        if row['fieldVerified'] or row['navigationReady'] or row['difficulty'] is not None or row['conditions'] is not None:
            failures.append('Unjustified verification/difficulty/current-condition claim: ' + row['id'])
        if row['sourceType'] != 'route' or row['publicationStatus'] != 'reference' or row['indexable']:
            failures.append('Unexpected publication/type flag: ' + row['id'])
        if not (OUT / row['geometryPath']).is_file():
            failures.append('Missing individual geometry: ' + row['id'])
        raw_path = OUT / 'raw/waymarked/relations' / (str(row['osmId']) + '.json')
        if not raw_path.is_file():
            failures.append('Route has no raw source: ' + row['id'])
        else:
            raw_data = json.loads(raw_path.read_text())
            if raw_data.get('id') != row['osmId'] or file_hash(raw_path) != row['sourceRawSha256']:
                failures.append('Route/source identity or hash mismatch: ' + row['id'])
    points = 0
    for feature in geometry['features']:
        if feature['geometry']['type'] != 'MultiLineString':
            failures.append('Unexpected geometry type: ' + str(feature.get('id')))
            continue
        for line in feature['geometry']['coordinates']:
            if len(line) < 2:
                failures.append('Line with fewer than two vertices')
            for point in line:
                points += 1
                if len(point) != 2 or not (-180 <= point[0] <= 180 and -90 <= point[1] <= 90):
                    failures.append('Invalid WGS84 point')
    source_hashes = 0
    for item in report['rawSources']:
        path = OUT / item['path']
        source_hashes += 1
        if not path.is_file() or file_hash(path) != item['sha256'] or path.stat().st_size != item['bytes']:
            failures.append('Raw source integrity failure: ' + item['path'])
    pbf = OUT / 'raw/geofabrik/crimean-fed-district-latest.osm.pbf'
    if file_hash(pbf) != geofabrik['source']['sha256']:
        failures.append('PBF source hash mismatch')
    raw_trails = load('raw-trails-krym.geojson')
    if len(raw_trails['features']) != geofabrik['rawTrailCount']:
        failures.append('Raw trail count mismatch')
    if file_hash(OUT / geofabrik['outputPath']) != geofabrik['outputSha256']:
        failures.append('Raw trail output hash mismatch')
    for feature in raw_trails['features']:
        p = feature['properties']
        if p['sourceType'] != 'raw_trail' or p['fieldVerified'] or p['navigationReady']:
            failures.append('Raw segment misclassified as verified: ' + p['id'])
    for rid, value in report['regions'].items():
        actual = sum(rid in row['regionIds'] for row in catalog['routes'])
        if actual != value['importedRouteCount']:
            failures.append('Regional count mismatch: ' + rid)
    for row in evidence['records']:
        if row.get('fieldVerified') or row.get('geometryVerified') or row.get('navigationReady'):
            failures.append('Online evidence incorrectly elevated to field/navigation verification')
        if not row.get('verificationScope') or not row.get('sourceUrl') or not row.get('checkedAt') or not row.get('recheckAfter'):
            failures.append('Unscoped or undated official evidence')
    evidence_ids=[r['routeId'] for r in evidence['records']]
    if len(evidence_ids)!=len(set(evidence_ids)) or not set(evidence_ids).issubset(ids):
        failures.append('Duplicate or orphan source-evidence record')
    coverage_count=0
    if (OUT/'verification-coverage.json').exists():
        coverage=load('verification-coverage.json')
        coverage_ids=[r['routeId'] for r in coverage['records']]
        coverage_count=len(coverage_ids)
        if len(coverage_ids)!=len(set(coverage_ids)) or set(coverage_ids)!=set(ids):
            failures.append('Source-research matrix does not cover every route exactly once')
        search_ids={r['id'] for r in coverage['searches']}
        for row in coverage['records']:
            if row['geometryVerified'] or row['fieldVerified'] or row['navigationReady'] or row['currentOpeningVerified']:
                failures.append('Online matrix incorrectly claims field/current-opening verification')
            if not set(row['searchQueryIds']).issubset(search_ids):
                failures.append('Untraceable online search reference: '+row['routeId'])
            if row['confirmationStatus']=='authoritative_description_found' and not row['sourceUrls']:
                failures.append('Authoritative source label without source: '+row['routeId'])
    result = {
        'auditedAt': datetime.now(timezone.utc).isoformat(),
        'status': 'passed' if not failures else 'failed',
        'scope': 'File integrity, referential consistency, data-shape checks and verification semantics. This is not a route or field-safety certification.',
        'routeRecordsChecked': checks, 'routeVerticesChecked': points,
        'rawApiSourceHashesChecked': source_hashes,
        'rawTrailRecordsChecked': len(raw_trails['features']),
        'officialEvidenceRecordsChecked': len(evidence['records']),
        'onlineResearchMatrixRecordsChecked': coverage_count,
        'failures': failures,
    }
    (OUT / 'catalog-audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
