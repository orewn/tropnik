"""Optional, attributable online map sources over the retained local basemap."""
from __future__ import annotations

from copy import deepcopy
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


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')


def add_online_style(style: dict, web_style_bytes: bytes, vector_bytes: bytes, dem_bytes: bytes) -> tuple[dict, bytes]:
    web = json.loads(web_style_bytes)
    vector = json.loads(vector_bytes)
    dem = json.loads(dem_bytes)
    require(web['sources']['openmaptiles'].get('url') == VECTOR_URL, 'Review the changed vector provider')
    require(web['sources']['hillshade-dem'].get('url') == DEM_TILEJSON_URL, 'Review the changed DEM provider')
    require(vector.get('maxzoom') == 14 and all(url.startswith('https://tiles.openfreemap.org/planet/')
            and url.endswith('/{z}/{x}/{y}.pbf') for url in vector.get('tiles', [])), 'Unexpected vector TileJSON snapshot')
    require(dem.get('encoding') == 'terrarium' and dem.get('tileSize') == 512
            and dem.get('tiles') == [DEM_TILE_URL], 'Unexpected documented terrain encoding')
    # Repeated preparation is idempotent, including after an earlier online style.
    style['sources'] = {key: value for key, value in style['sources'].items() if not key.startswith('online-')}
    style['layers'] = [layer for layer in style['layers'] if not layer['id'].startswith('online-')]
    vector_source = {'type': 'vector', 'url': VECTOR_URL, 'minzoom': 5, 'maxzoom': 14, 'attribution': VECTOR_CREDIT}
    # Mapterhorn's official Data Access page documents global planet coverage z0-12.
    # Higher regional datasets are deliberately not assumed to cover Russia.
    dem_source = {'type': 'raster-dem', 'tiles': [DEM_TILE_URL], 'tileSize': 512,
                  'encoding': 'terrarium', 'minzoom': 5, 'maxzoom': 12, 'attribution': DEM_CREDIT}
    style['sources']['online-openmaptiles'] = vector_source
    style['sources']['online-dem'] = dem_source
    online_layers = []
    for original in style['layers']:
        if original.get('source') != 'openmaptiles':
            continue
        layer = deepcopy(original)
        layer['id'] = 'online-' + original['id']
        layer['source'] = 'online-openmaptiles'
        layer['minzoom'] = max(5, layer.get('minzoom', 0))
        online_layers.append(layer)
    require(bool(online_layers), 'Native basemap has no OMT layers to reuse')
    local_shading = next(layer for layer in style['layers'] if layer['id'] == 'pilot-hillshade')
    shading = {'id': 'online-hillshade', 'type': 'hillshade', 'source': 'online-dem',
               'minzoom': 5, 'paint': deepcopy(local_shading['paint'])}
    water_index = next((index for index, layer in enumerate(online_layers) if layer['id'] == 'online-water'), len(online_layers))
    online_layers.insert(water_index, shading)
    first_pilot = next(index for index, layer in enumerate(style['layers'])
                       if layer.get('source') == 'openmaptiles' or layer['id'] == 'pilot-hillshade')
    style['layers'][first_pilot:first_pilot] = online_layers
    manifest = {
        'schemaVersion': 1, 'purpose': 'Optional online detail, separate from bundled offline coverage',
        'sourceIds': ['online-openmaptiles', 'online-dem'],
        'layerIds': [layer['id'] for layer in online_layers],
        'sources': {'online-openmaptiles': vector_source, 'online-dem': dem_source},
        'allowlistedRemoteResources': [VECTOR_URL, DEM_TILE_URL],
        'webStyleSha256': digest(web_style_bytes),
        'vectorTileJsonSnapshot': {'sourceUrl': VECTOR_URL, 'retrievedAt': '2026-11-06',
                                   'sha256': digest(vector_bytes), 'resolvedTiles': vector['tiles']},
        'demTileJsonSnapshot': {'sourceUrl': DEM_TILEJSON_URL, 'sha256': digest(dem_bytes),
                                'sourcePath': 'data/terrain-pilot/runtime/sources/mapterhorn-tilejson.json'},
        'primaryDocumentation': ['https://openfreemap.org/quick_start/', 'https://mapterhorn.com/data-access/',
                                 'https://mapterhorn.com/attribution', 'https://maplibre.org/maplibre-style-spec/sources/'],
        'minimumVisibleZoom': 5, 'globalDemMaximumNativeZoom': 12,
        'localFallbackRetained': True, 'remoteSourcesRemovableByPrefix': 'online-',
        'fullRussiaDetailedOffline': False, 'deviceNetworkRenderingVerified': False,
        'attribution': [VECTOR_CREDIT, DEM_CREDIT],
        'notes': ['The offline overview and bounded pilot sources remain separate and unchanged.',
                  'Online source availability is not a navigation or trail-condition verification.',
                  'All remote resources belong to online-* sources; glyphs remain bundled.'],
    }
    manifest_bytes = json_bytes(manifest)
    style.setdefault('metadata', {})['tropnik:onlineSourcesManifestSha256'] = digest(manifest_bytes)
    style['metadata']['tropnik:onlineLayerIds'] = manifest['layerIds']
    return style, manifest_bytes


def add_online_source_text(original: bytes) -> bytes:
    text = original.decode('utf-8').split(ONLINE_SOURCES_HEADING)[0].rstrip()
    text += ('\n\n' + ONLINE_SOURCES_HEADING + '\n'
             + VECTOR_CREDIT + '\n' + VECTOR_URL + '\nhttps://www.openstreetmap.org/copyright\n'
             + DEM_CREDIT + '\n' + DEM_TILEJSON_URL + '\nhttps://mapterhorn.com/attribution\n'
             'При доступной сети приложение может показывать подробные векторные слои и отмывку рельефа по всей области карты РФ. '
             'Это не скачанный пакет всей России: без сети остаются локальный обзор и подробная пилотная зона Бзерпинского карниза. '
             'Глобальная основа высот Mapterhorn имеет номинальное разрешение 30 м; это не точность измерения высоты. '
             'Светотень в нативной карте не является трёхмерной сеткой рельефа. '
             'Работа внешних слоёв на физическом устройстве этой проверкой не подтверждена.\n')
    return text.encode('utf-8')
