import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {terrainExaggerationForZoom,terrainPitchForZoom} from '../lib/map-camera-profile.ts';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('terrain camera stays restrained over Russia and gains depth on approach',()=>{
  assert.equal(terrainPitchForZoom(1.5,false),14);
  assert.ok(terrainPitchForZoom(4,false)<terrainPitchForZoom(8,true));
  assert.ok(terrainPitchForZoom(14,true)<=50);
  assert.ok(terrainExaggerationForZoom(2)<terrainExaggerationForZoom(12));
});

test('map attribution follows the five-second interactive-map safe harbour',()=>{
  const source=read('components/MapAttribution.tsx');
  assert.match(source,/© OpenStreetMap contributors/);
  assert.match(source,/setTimeout\(collapse,5000\)/);
  assert.match(source,/tropnik-map-attribution-seen/);
  assert.match(source,/Данные карты и лицензии/);
  assert.doesNotMatch(source,/Natural Earth/);
});

test('final palette and camera profile are wired into the atlas',()=>{
  const layout=read('app/layout.tsx');
  const css=read('app/map-polish.css');
  const atlas=read('components/Atlas.tsx');
  const style=read('scripts/create-map-style.mjs');
  assert.ok(layout.indexOf('map-polish.css')>layout.indexOf('event-categories.css'));
  for(const token of ['#F5F3EB','#FFFEFA','#244D3C','#1D3026','#59685D','#D5DCCE','#A56736'])assert.match(css,new RegExp(token,'i'));
  assert.match(atlas,/terrainPitchForZoom/);
  assert.match(atlas,/terrainExaggerationForZoom/);
  assert.doesNotMatch(atlas,/map\.easeTo\(\{pitch:55/);
  assert.match(style,/minzoom:2/);
  assert.match(style,/raster-contrast/);
});

test('reported map wedges, clipped labels and false detail banner stay fixed',()=>{
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  const css=read('app/map-polish.css');
  const generator=read('scripts/create-map-style.mjs');
  const style=JSON.parse(read('public/maps/tropa-style.json'));
  const sw=read('public/sw.js');
  assert.match(atlas,/constrainDirectionLabels/);
  assert.match(canvas,/constrainDirectionLabels/);
  assert.doesNotMatch(atlas,/Не все детали карты загрузились/);
  assert.match(css,/white-space:normal/);
  assert.match(css,/--map-label-shift/);
  assert.match(generator,/russia-priority-city-label/);
  const maskIndex=style.layers.findIndex(layer=>layer.id==='russia-outside-mask');
  const priorityIndex=style.layers.findIndex(layer=>layer.id==='russia-priority-city-label');
  assert.ok(maskIndex>=0&&priorityIndex>maskIndex,'priority Russian labels redraw after the outside mask');
  assert.match(sw,/tropnik-shell-v18/);
  assert.match(sw,/russia-canonical-mask\.geojson/);
});

test('map marker labels never delegate edge placement to native browser tooltips',()=>{
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  const layout=read('lib/map-direction-layout.ts');
  const css=read('app/map-polish.css');
  assert.match(layout,/MAP_LABEL_SAFE_AREA/);
  assert.match(layout,/mapLabelPlacement/);
  assert.match(layout,/coveredBottom/);
  assert.match(atlas,/TRAIL_POINT_HIT/);
  assert.match(atlas,/mapTrailPointFeatureCollection/);
  assert.match(canvas,/mapTrailPointEntries/);
  assert.match(canvas,/L\.circleMarker/);
  assert.doesNotMatch(atlas,/button\.title=t\.title/);
  assert.match(canvas,/finePointer=window\.matchMedia/);
  assert.match(canvas,/bindTooltip\(item\.title/);
  assert.match(layout,/removeAttribute\('title'\)/);
  assert.match(css,/data-map-label-placement='top'/);
  assert.match(css,/--map-label-shift-x/);
  assert.match(css,/--map-label-shift-y/);
  assert.match(css,/atlas-canvas\{overflow:hidden\}/);
  assert.match(css,/trail-marker:focus-visible\{background:transparent;transform:none\}/);
});

test('map stability release keeps terrain explicit and text collision-aware',()=>{
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  const generator=read('scripts/create-map-style.mjs');
  const style=JSON.parse(read('public/maps/tropa-style.json'));
  const layout=read('app/layout.tsx');
  assert.match(layout,/interface-refresh\.css/);
  assert.match(atlas,/terrainRef\.current/);
  assert.match(atlas,/territoryForMapPoint/);
  assert.match(atlas,/mapTrailPointFeatureCollection/);
  assert.doesNotMatch(atlas,/map\.on\('zoomend'[\s\S]{0,300}map\.setTerrain/);
  assert.match(canvas,/DETAIL_ENTER_ZOOM=4\.6,DETAIL_EXIT_ZOOM=3\.8/);
  assert.match(canvas,/bindMapLabelReflow/);
  assert.match(generator,/symbol-avoid-edges/);
  assert.match(generator,/hillshade-illumination-anchor':'map'/);
  assert.equal(style.layers.find(layer=>layer.id==='overview-relief').paint['raster-fade-duration'],0);
  for(const layer of style.layers.filter(layer=>layer.type==='symbol'&&layer.layout?.['text-field'])){
    if(layer.layout['symbol-placement']!=='line')assert.equal(layer.layout['symbol-avoid-edges'],true,layer.id);
  }
});

test('region marker dots stay centered on the exact engine coordinate',()=>{
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  const css=read('app/interface-refresh.css');
  assert.match(atlas,/new ml\.Marker\(\{element:el,anchor:'center'\}\)/);
  assert.match(canvas,/iconSize:\[DIRECTION_MARKER_SIZE,DIRECTION_MARKER_SIZE\],iconAnchor:\[DIRECTION_MARKER_SIZE\/2,DIRECTION_MARKER_SIZE\/2\]/);
  assert.doesNotMatch(canvas,/iconSize:\[1,1\],iconAnchor:\[0,0\]/);
  assert.match(css,/region-marker\.direction-cluster[\s\S]*width:44px!important/);
  assert.match(css,/Only the label shifts;[\s\S]*the dot and the map engine's anchor never move/);
  assert.match(css,/--map-anchor-shift-x/);
  assert.match(css,/data-map-camera='zooming'/);
  assert.match(atlas,/reconcileDirectionAnchors/);
  assert.match(canvas,/reconcileDirectionAnchors/);
  assert.doesNotMatch(atlas,/map\.on\('move',\s*scheduleDirectionLayout\)/);
  assert.doesNotMatch(canvas,/map\.on\('move',\s*scheduleDirectionLayout\)/);
  assert.doesNotMatch(canvas,/map\.on\('zoom',\s*scheduleDirectionLayout\)/);
  assert.match(atlas,/map\.on\('movestart'/);
  assert.match(canvas,/map\.on\('movestart'/);
  assert.match(atlas,/map\.on\('moveend'/);
  assert.match(canvas,/map\.on\('moveend'/);
});

test('mobile visual viewport and native route points stay cross-platform',()=>{
  const layout=read('lib/map-direction-layout.ts');
  const atlas=read('components/Atlas.tsx');
  const canvas=read('components/Atlas2D.tsx');
  const css=read('app/map-ui-release.css');
  assert.match(layout,/window\.visualViewport/);
  assert.match(layout,/visual\?\.addEventListener\('resize'/);
  assert.match(layout,/--map-label-max-width/);
  assert.match(layout,/placed:MapLabelRect\[\]/);
  assert.match(atlas,/type:'circle',source:TRAIL_POINTS/);
  assert.doesNotMatch(atlas,/new ml\.Marker\(\{element:button,anchor:'center'\}\).*visibleTrails/s);
  assert.match(canvas,/pane:'trail-points'/);
  assert.match(canvas,/bindTooltip\(item\.title,\{direction:'auto'/);
  assert.match(css,/tropnik-relief-tiles \.leaflet-tile\{opacity:1!important;transition:none!important\}/);
});
