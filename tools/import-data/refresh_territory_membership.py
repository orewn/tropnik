#!/usr/bin/env python3
"""Refresh route membership while retaining every existing territory byte.

The geographic asset, source provenance, label anchors and outlines are not
rebuilt. The existing territory builder's exact segment/polygon algorithm is
reused for the new on-demand route files, including cross-territory segments.
"""
import argparse
import importlib.util
import json
from pathlib import Path

from shapely.geometry import shape

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('territory_builder', ROOT / 'tools/map-package/build-territories.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def refreshed_index():
    raw = builder.INDEX_PATH.read_bytes()
    index = json.loads(raw)
    geometry_raw = builder.GEOMETRY_PATH.read_bytes()
    if builder.sha256(geometry_raw) != index['geometry']['sha256'] or len(geometry_raw) != index['geometry']['bytes']:
        raise ValueError('Pinned territory geometry changed before membership refresh')
    collection = json.loads(geometry_raw)
    features = {feature['id']: feature for feature in collection['features']}
    territories = index['territories']
    if len(features) != 85 or {r['id'] for r in territories} != set(features):
        raise ValueError('The existing territory inventory changed')
    route_sources, routes = builder.load_routes()
    membership = builder.memberships([shape(features[r['id']]['geometry']) for r in territories], routes)
    for territory, matches in zip(territories,membership,strict=True):
        territory['geometryUrls'] = [route_sources[i]['url'] for i in matches]
    matched = {i for indices in membership for i in indices}
    index['metadata'].update({
        'routeGeometrySourceCount':len(route_sources),
        'routeGeometryMatchedCount':len(matched),
        'routeGeometryUnmatchedUrls':[r['url'] for i,r in enumerate(route_sources) if i not in matched],
        'routeGeometrySources':route_sources,
    })
    return index


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check',action='store_true')
    args = parser.parse_args()
    index = refreshed_index()
    data = builder.encoded(index)
    if args.check:
        if data != builder.INDEX_PATH.read_bytes():
            raise SystemExit('Territory route membership is stale')
    else:
        builder.INDEX_PATH.write_bytes(data)
    print(json.dumps({'territories':len(index['territories']),
                      'routeGeometrySources':index['metadata']['routeGeometrySourceCount'],
                      'territoryGeometryUnchanged':True,
                      'geometrySha256':index['geometry']['sha256'],
                      'metadataSha256':builder.sha256(data)}))
