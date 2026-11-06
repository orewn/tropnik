#!/usr/bin/env python3
"""Build the 85 selected cartographic source features and their route membership.

Offline, deterministic inputs: the pinned 83-feature project overview plus the
two existing Crimea display features from the pinned UKR source. This is not a
claim about the present official administrative count or legal jurisdiction.
Install requirements-territories.txt; run this script, or use --check in CI.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import GeometryCollection, MultiPolygon, Point, Polygon, mapping, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'web/public'
INDEX_PATH = ROOT / 'web/lib/territories.generated.json'
GEOMETRY_PATH = PUBLIC / 'data/territories.geojson'
MEMBERSHIP_METHOD = 'exact-segment-polygon-intersection'
MERCATOR_LIMIT = 85.0511287798066
OUTLINE_PADDING = 6
OUTLINE_TOLERANCE = 0.0015  # Fraction of the feature's largest Mercator extent.
SOURCE_COMMIT = '9469f09592ced973a3448cf66b6100b741b64c0d'
SOURCE_SPECS = [
    {'path': 'web/public/data/regions.geojson',
     'sha256': 'dc13fa334586bf86698f3b0d4a2a88ec41dc1ddb8bad4f8928c27e551aa016bd',
     'isoOfSourceDataset': 'RUS', 'sourceFeatureCount': 83,
     'selectedNames': None, 'geometryDetail': 'existing project overview snapshot'},
    {'path': 'data/boundaries/raw/geoBoundaries-UKR-ADM1.geojson',
     'sha256': 'b2f9f4ad2e9be5888523219c0bb46a24332ead16b46305409098048fd361a2d6',
     'isoOfSourceDataset': 'UKR', 'sourceFeatureCount': 27,
     'selectedNames': ['Autonomous Republic of Crimea', 'Sevastopol'],
     'geometryDetail': 'full source snapshot, named feature selection'},
]

# Display translations only. Original names and source ISO attributes remain in
# the index and GeoJSON; these labels do not reassign source jurisdiction.
RUSSIAN_NAMES = {
    'Altai Krai': 'Алтайский край',
    'Republic of Mordovia': 'Республика Мордовия',
    'Tula Oblast': 'Тульская область',
    'Kurgan Oblast': 'Курганская область',
    'Ingushetia': 'Республика Ингушетия',
    'Khanty-Mansiysk Autonomous Okrug – Ugra': 'Ханты-Мансийский автономный округ — Югра',
    'Kirov Oblast': 'Кировская область',
    'Komi Republic': 'Республика Коми',
    'Kostroma Oblast': 'Костромская область',
    'Krasnoyarsk Krai': 'Красноярский край',
    'Zabaykalsky Krai': 'Забайкальский край',
    'Sverdlovsk Oblast': 'Свердловская область',
    'Volgograd Oblast': 'Волгоградская область',
    'Irkutsk Oblast': 'Иркутская область',
    'Perm Krai': 'Пермский край',
    'Pskov Oblast': 'Псковская область',
    'Rostov Oblast': 'Ростовская область',
    'Ryazan Oblast': 'Рязанская область',
    'Adygea': 'Республика Адыгея',
    'Samara Oblast': 'Самарская область',
    'Khakassia': 'Республика Хакасия',
    'Tambov Oblast': 'Тамбовская область',
    'Tatarstan': 'Республика Татарстан',
    'Tomsk Oblast': 'Томская область',
    'Nizhny Novgorod Oblast': 'Нижегородская область',
    'Republic of Karelia': 'Республика Карелия',
    'Arkhangelsk Oblast': 'Архангельская область',
    'Astrakhan Oblast': 'Астраханская область',
    'Belgorod Oblast': 'Белгородская область',
    'Bryansk Oblast': 'Брянская область',
    'Buryatia': 'Республика Бурятия',
    'Chechnya': 'Чеченская Республика',
    'Chelyabinsk Oblast': 'Челябинская область',
    'Chuvashia': 'Чувашская Республика',
    'Tyumen Oblast': 'Тюменская область',
    'North Ossetia–Alania': 'Республика Северная Осетия — Алания',
    'Penza Oblast': 'Пензенская область',
    'Amur Oblast': 'Амурская область',
    'Kabardino-Balkaria': 'Кабардино-Балкарская Республика',
    'Krasnodar Krai': 'Краснодарский край',
    'Kursk Oblast': 'Курская область',
    'Leningrad oblast': 'Ленинградская область',
    'Mari El': 'Республика Марий Эл',
    'Moscow': 'Москва',
    'Moscow Oblast': 'Московская область',
    'Murmansk Oblast': 'Мурманская область',
    'Nenets Autonomous Okrug': 'Ненецкий автономный округ',
    'Novgorod Oblast': 'Новгородская область',
    'Novosibirsk Oblast': 'Новосибирская область',
    'Omsk Oblast': 'Омская область',
    'Oryol Oblast': 'Орловская область',
    'Saint Petersburg': 'Санкт-Петербург',
    'Sakhalin Oblast': 'Сахалинская область',
    'Sakha Republic': 'Республика Саха (Якутия)',
    'Saratov Oblast': 'Саратовская область',
    'Smolensk Oblast': 'Смоленская область',
    'Stavropol Krai': 'Ставропольский край',
    'Tuva': 'Республика Тыва',
    'Tver Oblast': 'Тверская область',
    'Udmurtia': 'Удмуртская Республика',
    'Kaluga Oblast': 'Калужская область',
    'Lipetsk Oblast': 'Липецкая область',
    'Magadan Oblast': 'Магаданская область',
    'Ulyanovsk Oblast': 'Ульяновская область',
    'Vladimir Oblast': 'Владимирская область',
    'Vologda Oblast': 'Вологодская область',
    'Yaroslavl Oblast': 'Ярославская область',
    'Voronezh Oblast': 'Воронежская область',
    'Yamalo-Nenets Autonomous Okrug': 'Ямало-Ненецкий автономный округ',
    'Altai Republic': 'Республика Алтай',
    'Ivanovo Oblast': 'Ивановская область',
    'Jewish Autonomous Oblast': 'Еврейская автономная область',
    'Kalmykia': 'Республика Калмыкия',
    'Kamchatka Krai': 'Камчатский край',
    'Karachay-Cherkessia': 'Карачаево-Черкесская Республика',
    'Kemerovo Oblast': 'Кемеровская область',
    'Khabarovsk Krai': 'Хабаровский край',
    'Chukotka Autonomous Okrug': 'Чукотский автономный округ',
    'Dagestan': 'Республика Дагестан',
    'Kaliningrad': 'Калининградская область',
    'Orenburg Oblast': 'Оренбургская область',
    'Primorsky Krai': 'Приморский край',
    'Bashkortostan': 'Республика Башкортостан',
    'Autonomous Republic of Crimea': 'Крым',
    'Sevastopol': 'Севастополь',
}


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def encoded(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, allow_nan=False,
                       separators=(',', ':')) + '\n').encode('utf-8')


def russia_longitude(lng: float) -> float:
    """Same half-up rounding as russiaLongitude in russia-viewport.js."""
    if not math.isfinite(lng):
        raise ValueError('Longitude must be finite')
    return lng + 360 * math.floor((105 - lng) / 360 + 0.5)


def normalize_geometry(geometry):
    return shapely.transform(geometry, lambda xy: np.column_stack((
        xy[:, 0] + 360 * np.floor((105 - xy[:, 0]) / 360 + 0.5), xy[:, 1])))


def polygon_parts(geometry):
    if isinstance(geometry, Polygon):
        return [geometry]
    if isinstance(geometry, MultiPolygon):
        return list(geometry.geoms)
    raise ValueError(f'Expected polygon geometry, received {geometry.geom_type}')


def load_territories():
    sources, selected = [], []
    for spec in SOURCE_SPECS:
        raw = (ROOT / spec['path']).read_bytes()
        if sha256(raw) != spec['sha256']:
            raise ValueError(f"Pinned boundary checksum changed: {spec['path']}")
        document = json.loads(raw)
        features = document['features']
        if len(features) != spec['sourceFeatureCount']:
            raise ValueError('Boundary feature count changed')
        chosen = [f for f in features if spec['selectedNames'] is None
                  or f['properties']['shapeName'] in spec['selectedNames']]
        if spec['selectedNames'] is not None and {f['properties']['shapeName'] for f in chosen} != set(spec['selectedNames']):
            raise ValueError('Named Crimea display features missing')
        sources.append({key: value for key, value in spec.items() if key != 'selectedNames'} | {
            'bytes': len(raw), 'selectedFeatureCount': len(chosen),
            'selectedFeatureNames': [f['properties']['shapeName'] for f in chosen],
        })
        for feature in chosen:
            properties = feature['properties']
            if properties['shapeGroup'] != spec['isoOfSourceDataset']:
                raise ValueError('Source ISO changed; do not silently reassign provenance')
            original = shape(feature['geometry'])
            if original.is_empty or not original.is_valid:
                raise ValueError(f"Invalid source polygon: {properties['shapeName']}")
            geometry = normalize_geometry(original)
            joined_seam = False
            if not geometry.is_valid and isinstance(geometry, MultiPolygon):
                # The canonical Chukotka components share a technical 180-degree
                # edge after unwrapping. Join that edge; retain the same area.
                joined = unary_union(list(geometry.geoms))
                if not joined.is_valid or not math.isclose(joined.area, geometry.area, rel_tol=1e-12, abs_tol=1e-10):
                    raise ValueError('Normalization changed polygon area')
                geometry, joined_seam = joined, True
            if not geometry.is_valid or geometry.bounds[2] - geometry.bounds[0] >= 180:
                raise ValueError('Invalid or world-spanning normalized territory')
            selected.append({'properties': dict(properties), 'geometry': geometry,
                             'sourcePath': spec['path'], 'sourceSha256': spec['sha256'],
                             'datelineSeamJoined': joined_seam})
    names = {item['properties']['shapeName'] for item in selected}
    if names != set(RUSSIAN_NAMES) or len(selected) != 85:
        raise ValueError('Expected exactly the 85 translated selected source features')
    return sources, sorted(selected, key=lambda item: item['properties']['shapeID'])


def load_routes():
    records, geometries = [], []
    files = sorted([*(PUBLIC / 'data/routes').glob('*.geojson'),
                    *(PUBLIC / 'data/imported').glob('*.geojson')])
    if not files:
        raise ValueError('No local route geometry source files')
    for path in files:
        raw = path.read_bytes()
        document = json.loads(raw)
        features = document.get('features') if document['type'] == 'FeatureCollection' else [document]
        parts = []
        for feature in features:
            raw_geometry = feature.get('geometry', feature)
            if raw_geometry['type'] not in ('LineString', 'MultiLineString'):
                raise ValueError(f'Expected route line segments: {path}')
            geometry = normalize_geometry(shape(raw_geometry))
            if geometry.is_empty or not geometry.is_valid:
                raise ValueError(f'Invalid route geometry: {path}')
            parts.append(geometry)
        if not parts:
            raise ValueError(f'Empty route source: {path}')
        # A collection does not connect disconnected source segments.
        geometries.append(parts[0] if len(parts) == 1 else GeometryCollection(parts))
        records.append({'url': '/' + path.relative_to(PUBLIC).as_posix(),
                        'sha256': sha256(raw), 'bytes': len(raw),
                        'featureCount': len(features)})
    return records, geometries


def memberships(polygons, routes):
    """Intersects entire real segments, including crossings with no inner vertex."""
    tree = STRtree(polygons)
    result = [[] for _ in polygons]
    for route_index, route in enumerate(routes):
        for territory_index in sorted(int(index) for index in tree.query(route, predicate='intersects')):
            result[territory_index].append(route_index)
    return result


def mercator_geometry(geometry):
    return shapely.transform(geometry, lambda xy: np.column_stack((
        np.radians(xy[:, 0]),
        np.arcsinh(np.tan(np.radians(np.clip(xy[:, 1], -MERCATOR_LIMIT, MERCATOR_LIMIT)))))))


def outline(geometry) -> str:
    projected = mercator_geometry(geometry)
    west, south, east, north = projected.bounds
    extent = max(east - west, north - south)
    if extent <= 0:
        raise ValueError('Territory outline has no extent')
    simplified = projected.simplify(extent * OUTLINE_TOLERANCE, preserve_topology=True)
    scale = (100 - 2 * OUTLINE_PADDING) / extent
    offset_x = (100 - (east - west) * scale) / 2
    offset_y = (100 - (north - south) * scale) / 2

    def point(x, y):
        return f'{(x-west)*scale+offset_x:.4f},{(north-y)*scale+offset_y:.4f}'

    paths = []
    for polygon in polygon_parts(simplified):
        for ring in [polygon.exterior, *polygon.interiors]:
            coordinates = list(ring.coords)[:-1]
            paths.append('M' + 'L'.join(point(x, y) for x, y in coordinates) + 'Z')
    return ''.join(paths)


def build():
    sources, items = load_territories()
    route_sources, routes = load_routes()
    membership = memberships([item['geometry'] for item in items], routes)
    territories, features = [], []
    for item, matches in zip(items, membership, strict=True):
        source = item['properties']
        geometry = item['geometry']
        source_name = source['shapeName']
        identifier = 'territory-' + source['shapeID']
        center = max(polygon_parts(geometry), key=lambda polygon: polygon.area).representative_point()
        center_xy = [round(center.x, 7), round(center.y, 7)]
        if not geometry.covers(Point(center_xy)):
            raise ValueError(f'Label center left its polygon: {source_name}')
        bounds = [round(value, 7) for value in geometry.bounds]
        urls = [route_sources[index]['url'] for index in matches]
        territories.append({'id': identifier, 'name': RUSSIAN_NAMES[source_name],
                            'shapeNames': [source_name], 'center': center_xy,
                            'bounds': bounds, 'outline': outline(geometry),
                            'geometryUrls': urls, 'sourceProperties': source,
                            'sourcePath': item['sourcePath']})
        features.append({'type': 'Feature', 'id': identifier,
                         'properties': source | {
                             'id': identifier, 'territoryId': identifier,
                             'name': RUSSIAN_NAMES[source_name],
                             'sourcePath': item['sourcePath'], 'sourceSha256': item['sourceSha256'],
                             'displayLongitudeReference': 105, 'datelineSeamJoined': item['datelineSeamJoined'],
                             'legalBoundaryClaim': False, 'navigationReady': False,
                         }, 'geometry': mapping(geometry)})
    geometry_document = {'type': 'FeatureCollection', 'name': 'Selected cartographic territories',
                         'license': 'ODbL-1.0',
                         'attribution': '© OpenStreetMap contributors · geoBoundaries (OpenStreetMap / Wambacher); display selection by Тропник',
                         'metadata': {'version': 1, 'elementCount': len(features),
                                      'countMeaning': 'Selected historical cartographic source features, not an official present administrative count',
                                      'longitudeDomain': 'continuous around 105 degrees east; east may exceed 180',
                                      'legalBoundaryClaim': False, 'navigationReady': False},
                         'features': features}
    geometry_bytes = encoded(geometry_document)
    matched = {index for indices in membership for index in indices}
    index_document = {
        'version': 1, 'viewBox': '0 0 100 100', 'sources': sources,
        'geometry': {'url': '/data/territories.geojson', 'sha256': sha256(geometry_bytes),
                     'bytes': len(geometry_bytes), 'features': len(features)},
        'metadata': {
            'elementCount': len(items),
            'countMeaning': '83 existing RUS source features plus 2 selected UKR source features for existing Crimea display coverage; not an official present administrative count',
            'sourceYearRepresented': '2017', 'rawBoundarySourceCommit': SOURCE_COMMIT,
            'legalBoundaryClaim': False, 'navigationReady': False,
            'membershipMethod': MEMBERSHIP_METHOD,
            'membershipGeometry': 'Pinned input polygons before outline simplification; boundary touching is included; existing route segments are never joined',
            'routeGeometrySourceCount': len(route_sources),
            'routeGeometryMatchedCount': len(matched),
            'routeGeometryUnmatchedUrls': [record['url'] for index, record in enumerate(route_sources) if index not in matched],
            'routeGeometrySources': route_sources,
            'catalogPolicy': 'Geometry source records are not published catalog entries. UI intersects these URLs with its active catalog; membership grants no verification or permission.',
            'longitudeNormalization': 'lng + 360 * floor((105 - lng) / 360 + 0.5), matching russiaLongitude',
            'centerMethod': 'Interior representative point of the largest polygon component',
            'outline': {'projection': 'Web Mercator', 'viewBox': '0 0 100 100',
                        'padding': OUTLINE_PADDING, 'fillRule': 'evenodd',
                        'simplificationFractionOfExtent': OUTLINE_TOLERANCE,
                        'preserveTopology': True, 'preserveAspectRatio': True},
            'limitations': [
                'RUS uses the existing simplified overview source and cannot claim full-resolution coastal accuracy.',
                'The exact intersection is relative to the supplied source polygons, not a field survey or current legal boundary.',
                'Source shapeGroup and shapeISO values are preserved, including UKR attributes for Crimea and Sevastopol.',
                'The unwrapped GeoJSON is a renderer display asset; it is not canonical RFC 7946 longitude interchange.',
            ],
            'generator': {'path': 'tools/map-package/build-territories.py',
                          'sha256': sha256(Path(__file__).read_bytes()),
                          'shapely': shapely.__version__, 'geos': shapely.geos_version_string,
                          'numpy': np.__version__},
        },
        'territories': territories,
    }
    return index_document, geometry_document


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Compare generated bytes; do not modify files')
    args = parser.parse_args()
    index, geometry = build()
    for path, document in [(INDEX_PATH, index), (GEOMETRY_PATH, geometry)]:
        raw = encoded(document)
        if args.check:
            if not path.exists() or path.read_bytes() != raw:
                raise SystemExit(f'Generated artifact missing or stale: {path.relative_to(ROOT)}')
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
    verb = 'Verified' if args.check else 'Generated'
    print(f"{verb} {len(index['territories'])} cartographic features; "
          f"{index['metadata']['routeGeometrySourceCount']} route geometry source records, "
          f"{index['metadata']['routeGeometryMatchedCount']} intersect the selected source polygons.")


if __name__ == '__main__':
    main()
