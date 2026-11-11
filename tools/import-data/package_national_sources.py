#!/usr/bin/env python3
"""Create a deterministic, complete archive of the national source responses."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/catalog/national'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        while block := source.read(1024 * 1024):
            value.update(block)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    destination = args.destination.resolve()
    discovery = json.loads((OUT / 'discovery.json').read_text())
    report = json.loads((OUT / 'import-report.json').read_text())
    catalog = json.loads((OUT / 'routes.json').read_text())
    accepted_sources = {r['sourceRawPath'] for r in catalog['routes']}
    expected = {r['path']: r for r in discovery['rawSources'] + report['rawSources']}
    for path, record in expected.items():
        data = (OUT / path).read_bytes()
        if len(data) != record['bytes'] or digest(data) != record['sha256']:
            raise ValueError('Source identity mismatch: ' + path)
    paths = sorted((OUT / 'raw').rglob('*.json'))
    required_paths = set(expected) | {str(Path(p).with_suffix('.json.source.json')) for p in expected}
    actual_paths = {str(p.relative_to(OUT)) for p in paths}
    if actual_paths != required_paths:
        raise ValueError('Unexpected or missing upstream response/sidecar')
    manifest = {'schemaVersion':1, 'kind':'complete-national-route-source-snapshot',
                'license':'ODbL-1.0', 'licenseUrl':'https://opendatacommons.org/licenses/odbl/1-0/',
                'attribution':'© OpenStreetMap contributors; distributed by Waymarked Trails',
                'sourcePage':'https://hiking.waymarkedtrails.org/',
                'copyrightPage':'https://www.openstreetmap.org/copyright',
                'scope':'Original successful responses, including rejected candidates. Source access, attribution and share-alike obligations remain attached to OSM-derived databases. This is not field or current-access verification.',
                'discoverySha256':digest((OUT / 'discovery.json').read_bytes()),
                'importReportSha256':digest((OUT / 'import-report.json').read_bytes()),
                'files':[{'path':str(p.relative_to(OUT)), 'bytes':p.stat().st_size, 'sha256':digest(p.read_bytes())} for p in paths]}
    manifest_bytes = (json.dumps(manifest,ensure_ascii=False,separators=(',',':'))+'\n').encode()
    destination.parent.mkdir(parents=True,exist_ok=True)
    def add(archive, path, data):
        info = tarfile.TarInfo(path)
        info.size = len(data)
        info.mtime = 0
        info.mode = 0o644
        info.uid = info.gid = 0
        archive.addfile(info, io.BytesIO(data))
    with destination.open('wb') as output, gzip.GzipFile(filename='',mode='wb',fileobj=output,mtime=0,compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed,mode='w|',format=tarfile.USTAR_FORMAT) as archive:
            add(archive,'source-snapshot.json',manifest_bytes)
            for path in paths:
                add(archive,str(path.relative_to(OUT)),path.read_bytes())
    receipt = {'schemaVersion':1, 'filename':destination.name, 'bytes':destination.stat().st_size,
               'license':'ODbL-1.0', 'attribution':'© OpenStreetMap contributors; distributed by Waymarked Trails',
               'sha256':file_digest(destination), 'manifestSha256':digest(manifest_bytes),
               'sourceFiles':len(paths), 'rawResponses':len(expected),
               'uncompressedSourceBytes':sum(p.stat().st_size for p in paths),
               'acceptedRelationSourceBytes':sum(expected[p]['bytes'] for p in accepted_sources),
               'allRelationSourceBytes':sum(r['bytes'] for r in report['rawSources']),
               'allListSourceBytes':sum(r['bytes'] for r in discovery['rawSources']),
               'retrievalWindowUtc':{'first':min(r['retrievedAt'] for r in expected.values()),
                                     'last':max(r['retrievedAt'] for r in expected.values())},
               'includesRejectedRelations':True, 'includesOriginalSourceSidecars':True,
               'scope':'Original successful responses for the new national acquisition, including rejected candidates. The six-destination historical raw snapshot is not included or revalidated.',
               'verificationCommand':f'python tools/import-data/audit_national_catalog.py --archive {destination.name}'}
    (OUT / 'source-archive.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(receipt,ensure_ascii=False))


if __name__ == '__main__':
    main()
