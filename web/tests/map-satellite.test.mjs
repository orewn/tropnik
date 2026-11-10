import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MapStyleSession} from '../lib/map-lifecycle.ts';
import {satelliteStyle,satelliteSourceForBounds,SATELLITE_SOURCE,SATELLITE_TILES,SATELLITE_MAX_ZOOM,SATELLITE_OVERVIEW_SOURCE,SATELLITE_OVERVIEW_TILES,SATELLITE_OVERVIEW_MAX_ZOOM} from '../lib/map-satellite.ts';
import {canvasStyle} from '../public/maps/canvas-style.js';
import {isPriorityCity,priorityCityFontSize,priorityCityNames} from '../public/maps/map-city-labels.js';

test('real satellite imagery replaces ground surfaces, retaining Russia mask, labels and routes',()=>{
  const base=JSON.parse(readFileSync(new URL('../public/maps/tropa-style.json',import.meta.url),'utf8'));
  const original=structuredClone(base),view=satelliteStyle(base);
  assert.deepEqual(base,original,'switching modes must not mutate the saved detailed style');
  assert.deepEqual(view.sources['russia-mask'],base.sources['russia-mask']);
  assert.equal(view.sources[SATELLITE_SOURCE].maxzoom,14);
  assert.equal(SATELLITE_MAX_ZOOM,14);
  assert.match(SATELLITE_TILES,/\/s2cloudless_3857\/default\/g\/\{z\}\/\{y\}\/\{x\}\.jpg$/);
  assert.doesNotMatch(SATELLITE_TILES,/s2cloudless-20(?:1[89]|2\d)/,'newer paid vintages must not replace the licensed source');
  const imagery=view.layers.findIndex(layer=>layer.id===SATELLITE_SOURCE);
  for(const id of ['paths','tracks','city-label','russia-outside-mask','russia-priority-city-label']){
    assert.ok(view.layers.findIndex(layer=>layer.id===id)>imagery,`${id} stays above imagery`);
  }
  assert.ok(!view.layers.some(layer=>layer.type==='hillshade'));
  assert.ok(!view.layers.some(layer=>['water','forest','buildings'].includes(layer.id)),'opaque fills must not cover photography');
  assert.equal(view.sources[SATELLITE_OVERVIEW_SOURCE].maxzoom,8);
  assert.equal(SATELLITE_OVERVIEW_MAX_ZOOM,8);
  assert.equal(view.sources[SATELLITE_OVERVIEW_SOURCE].tiles[0],SATELLITE_OVERVIEW_TILES);
  assert.match(SATELLITE_OVERVIEW_TILES,/^https:\/\/tiles\.maps\.eox\.at\/wmts\/1\.0\.0\/bluemarble_3857\/default\/g\/\{z\}\/\{y\}\/\{x\}\.jpg$/);
  for(const id of [SATELLITE_SOURCE,SATELLITE_OVERVIEW_SOURCE]){
    const layer=view.layers.find(layer=>layer.id===id);
    assert.equal(layer.layout.visibility,'none','unused imagery must not request tiles');
    assert.equal(layer.paint['raster-opacity'],0);
    assert.deepEqual(layer.paint['raster-opacity-transition'],{duration:0},'replacement is atomic after ready');
    assert.ok(view.layers.findIndex(layer=>layer.id===id)<view.layers.findIndex(layer=>layer.id==='russia-outside-mask'));
  }
});

test('known source gaps select real overview imagery across either dateline representation',()=>{
  const source=(west,south,east,north)=>satelliteSourceForBounds({west,south,east,north});
  for(const bounds of [[157.73,61.8,190.96,71.61],[178.5,66,180.5,68],[178.5,70.8,181.2,71.7],[-181.5,66,-179.5,68],[179,66,-179,68],[-180,41,180,82],[19,41,191,82],[539,66,541,68]]){
    assert.equal(source(...bounds),'eox-bluemarble',JSON.stringify(bounds));
  }
  for(const bounds of [[30,66,36,71],[169,64,175.9,68],[183.1,65,190,70],[178,55,181,60.9],[178,72.6,181,74],[NaN,66,181,68]]){
    assert.equal(source(...bounds),'eox-s2',JSON.stringify(bounds));
  }
});

test('satellite selection is lazy, restores after offline fallback and ignores obsolete loads',async()=>{
  const applied=[];let imageryLoads=0,resolve;
  const delayed=new Promise(yes=>{resolve=yes;});
  const session=new MapStyleSession({online:true,preference:'detail',currentMode:'detail',detail:async()=> 'map',overview:()=> 'saved',satellite:async()=>{imageryLoads++;return imageryLoads===1?delayed:'imagery';},apply:(style,mode)=>applied.push({style,mode}),onError:()=>assert.fail('unexpected error')});
  assert.equal(imageryLoads,0,'ordinary map startup must not fetch imagery');
  const selecting=session.select('satellite');
  await session.connect(false);
  resolve('late imagery');
  assert.equal(await selecting,false);
  assert.deepEqual(applied,[{style:'saved',mode:'overview'}]);
  await session.connect(true);
  assert.deepEqual(applied.at(-1),{style:'imagery',mode:'satellite'});
  session.fallback();
  assert.deepEqual(applied.at(-1),{style:'saved',mode:'overview'});
  await session.select('detail');
  assert.deepEqual(applied.at(-1),{style:'map',mode:'detail'});
});

test('canvas satellite overlay keeps paths and labels on a transparent ground',()=>{
  class Symbolizer{constructor(options){this.options=options;}}
  class Padding{constructor(padding,symbolizer){this.padding=padding;this.symbolizer=symbolizer;}}
  const p={PolygonSymbolizer:Symbolizer,LineSymbolizer:Symbolizer,CenteredTextSymbolizer:Symbolizer,Padding};
  const ordinary=canvasStyle(p,true),imagery=canvasStyle(p,true,true),withoutPaths=canvasStyle(p,false,true);
  assert.equal(ordinary.backgroundColor,'#e9ecdf');
  assert.equal(imagery.backgroundColor,'rgba(0,0,0,0)');
  assert.ok(imagery.paintRules.every(rule=>!['landcover','landuse','water','building','park'].includes(rule.dataLayer)));
  assert.equal(ordinary.labelRules.length,imagery.labelRules.length);
  assert.equal(imagery.paintRules.length,withoutPaths.paintRules.length+1);
  const priority=imagery.labelRules[0],city={props:{class:'city','name:ru':'Санкт-Петербург'}};
  assert.equal(priority.filter(5,city),true);
  assert.match(priority.symbolizer.symbolizer.options.font(6),/^600 17px /);
  assert.equal(priority.filter(5,{props:{class:'village',name:'Москва'}}),false,'a name alone must not turn a village into a large city');
  assert.equal(priority.filter(5,{props:{class:'city',name:'Invented place'}}),false);
});

test('both map renderers use the same sourced priority cities and size stops',()=>{
  const style=JSON.parse(readFileSync(new URL('../public/maps/tropa-style.json',import.meta.url),'utf8'));
  const priority=style.layers.find(layer=>layer.id==='russia-priority-city-label');
  assert.deepEqual(priority.filter[2][2][1],priorityCityNames);
  assert.deepEqual([3,6,10,18].map(priorityCityFontSize),[13,17,20,20]);
  assert.equal(isPriorityCity({class:'city','name:ru':'Москва',name:'Moscow'}),true);
});
