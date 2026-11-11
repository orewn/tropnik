"""Reviewed data-source configuration for the shared renderer; no style SDK."""
from __future__ import annotations

import json
from asset_integrity import digest, require

VECTOR_URL = 'https://tiles.openfreemap.org/planet/latest'
DEM_TILEJSON_URL = 'https://tiles.mapterhorn.com/tilejson.json'
DEM_TILE_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'
ONLINE_SOURCES_HEADING = 'Детальная карта онлайн (не включена в автономное покрытие)'
VECTOR_CREDIT = 'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors'
DEM_CREDIT = ('Terrain © Mapterhorn; produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 '
              'and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS '
              'by the European Union and ESA; all rights reserved')
SOURCES = {
    'vector': {'format': 'mvt', 'tileJson': VECTOR_URL, 'maxNativeZoom': 14, 'attribution': VECTOR_CREDIT},
    'elevation': {'format': 'terrarium', 'tiles': DEM_TILE_URL, 'tileSize': 512,
                  'maxNativeZoom': 12, 'attribution': DEM_CREDIT},
    'satellite': {'format': 'jpeg', 'tiles': 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg',
                  'maxNativeZoom': 14, 'attribution': 'EOxCloudless by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017), CC BY 4.0'},
    'satellite-overview': {'format': 'jpeg', 'tiles': 'https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/{z}/{y}/{x}.jpg',
                           'maxNativeZoom': 8, 'attribution': 'NASA Earth Observatory · Blue Marble · EOX::Maps'},
}
SNAPSHOTS = {'vector': 'maps/sources/openfreemap-tilejson.json',
             'elevation': 'maps/terrain-pilot/sources/mapterhorn-tilejson.json'}


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')


def build_online_sources(vector_bytes: bytes, dem_bytes: bytes) -> bytes:
    vector = json.loads(vector_bytes)
    dem = json.loads(dem_bytes)
    require(vector.get('maxzoom') == 14 and bool(vector.get('tiles')) and all(
        url.startswith('https://tiles.openfreemap.org/planet/') and url.endswith('/{z}/{x}/{y}.pbf')
        for url in vector['tiles']), 'Unexpected vector TileJSON snapshot')
    require(dem.get('encoding') == 'terrarium' and dem.get('tileSize') == 512
            and dem.get('tiles') == [DEM_TILE_URL], 'Unexpected documented terrain encoding')
    return json_bytes({
        'schemaVersion': 2, 'runtime': 'tropnik-canvas',
        'purpose': 'Attributable online data sources, separate from bundled offline coverage',
        'sources': SOURCES,
        'snapshots': {name: {'assetPath': SNAPSHOTS[name], 'sizeBytes': len(data), 'sha256': digest(data)}
                      for name, data in [('vector', vector_bytes), ('elevation', dem_bytes)]},
        'primaryDocumentation': ['https://openfreemap.org/quick_start/', 'https://mapterhorn.com/data-access/',
                                 'https://mapterhorn.com/attribution', 'https://cloudless.eox.at/documentation/faq'],
        'localFallbackRetained': True, 'fullRussiaDetailedOffline': False,
        'deviceNetworkRenderingVerified': False,
    })


def verify_online_sources(manifest_bytes: bytes, read) -> dict:
    config = json.loads(manifest_bytes)
    require(config.get('schemaVersion') == 2 and config.get('runtime') == 'tropnik-canvas'
            and config.get('sources') == SOURCES and config.get('localFallbackRetained') is True
            and config.get('fullRussiaDetailedOffline') is False, 'Online map data configuration differs')
    require(set(config.get('snapshots', {})) == set(SNAPSHOTS), 'Online data provenance is incomplete')
    data = {}
    for name, path in SNAPSHOTS.items():
        record = config['snapshots'][name]
        require(record.get('assetPath') == path, 'Online source snapshot moved')
        data[name] = read(path)
        require(record.get('sizeBytes') == len(data[name]) and record.get('sha256') == digest(data[name]),
                'Online source snapshot changed')
    require(build_online_sources(data['vector'], data['elevation']) == manifest_bytes,
            'Online source configuration does not match its reviewed inputs')
    return {'onlineSourcesManifestSha256': digest(manifest_bytes),
            'onlineMapSourcesExplicitlyAllowlisted': True, 'onlineSourceConfigurationVersion': 2,
            'onlineMapSourceUrls': [source.get('tileJson', source.get('tiles')) for source in SOURCES.values()],
            'bundledOfflineMapAvailable': True}


def add_online_source_text(original: bytes) -> bytes:
    text = original.decode('utf-8').split(ONLINE_SOURCES_HEADING)[0].rstrip()
    text += ('\n\n' + ONLINE_SOURCES_HEADING + '\n'
             + VECTOR_CREDIT + '\n' + VECTOR_URL + '\nhttps://www.openstreetmap.org/copyright\n'
             + DEM_CREDIT + '\n' + DEM_TILEJSON_URL + '\nhttps://mapterhorn.com/attribution\n'
             'При доступной сети собственный движок может читать подробные векторные тайлы и высоты. '
             'Это не скачанный пакет всей России: без сети остаются локальный обзор и подробная пилотная зона Бзерпинского карниза. '
             'Глобальная основа высот Mapterhorn имеет номинальное разрешение 30 м; это не точность измерения высоты. '
             'Отмывка в основной карте и отдельная трёхмерная сетка локальной сцены используют разные способы изображения тех же источников высот.\n'
             + SOURCES['satellite']['attribution'] + '\nhttps://cloudless.eox.at/documentation/faq\n'
             + SOURCES['satellite-overview']['attribution'] + '\nhttps://maps.eox.at\n'
             'Снимки и онлайн-тайлы не входят в автономный пакет. Работа внешних слоёв на физическом устройстве этой проверкой не подтверждена.\n')
    return text.encode('utf-8')
