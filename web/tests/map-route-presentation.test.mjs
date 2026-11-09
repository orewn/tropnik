import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {routeLineEdges,routeStrokeWidth,territoryDetailOpacity} from '../lib/map-route-presentation.ts';
import {canvasStyle} from '../public/maps/canvas-style.js';
import {satelliteStyle} from '../lib/map-satellite.ts';

const require=createRequire(new URL('../package.json',import.meta.url));
const spec=createRequire(require.resolve('maplibre-gl/package.json'))('@maplibre/maplibre-gl-style-spec');
const style=JSON.parse(readFileSync(new URL('../public/maps/tropa-style.json',import.meta.url),'utf8'));

test('the two edges annotate an actual single line without changing any source vertices',()=>{
  const geometry={type:'LineString',coordinates:[[44,43,920],[44.01,43.02,1010],[44.1,43.04,1100]]};
  const original=structuredClone(geometry);
  const edges=routeLineEdges(geometry);
  assert.deepEqual(edges.map(edge=>[edge.kind,edge.coordinate]),[['first',[44,43]],['last',[44.1,43.04]]]);
  edges[0].coordinate[0]=99;
  assert.deepEqual(geometry,original,'marker edits cannot mutate the source route');
});

test('disconnected, reversed and merely adjacent source parts do not invent a whole-route start and finish',()=>{
  for(const parts of [
    [[[44,43],[44.1,43]],[[45,43],[45.1,43]]],
    [[[44.1,43],[44,43]],[[44.1,43],[44.2,43]]],
    [[[44,43],[44.1,43]],[[44.1,43],[44.2,43]]],
  ]) assert.deepEqual(routeLineEdges({type:'MultiLineString',coordinates:parts}),[]);
  const line=coordinates=>({type:'Feature',properties:{},geometry:{type:'LineString',coordinates}});
  assert.deepEqual(routeLineEdges({type:'FeatureCollection',features:[line([[44,43],[44.1,43]]),line([[45,43],[45.1,43]])]}),[]);
});

test('a shared edge is one mark, including equivalent antimeridian coordinates',()=>{
  const ring={type:'LineString',coordinates:[[44,43],[44.1,43],[44,43]]};
  assert.equal(routeLineEdges(ring).length,1);
  assert.equal(routeLineEdges(ring)[0].kind,'shared');
  assert.equal(routeLineEdges({type:'LineString',coordinates:[[180,65],[179.9,65],[-180,65]]})[0].kind,'shared');
  assert.deepEqual(routeLineEdges({type:'LineString',coordinates:[[44,43],[44,43],[44,43]]}),[]);
});

test('polygons and catalog points cannot become invented route edges',()=>{
  for(const geometry of [
    {type:'Point',coordinates:[44,43]},
    {type:'Polygon',coordinates:[[[44,43],[44.1,43],[44,43]]]},
    {type:'GeometryCollection',geometries:[]},
  ])assert.deepEqual(routeLineEdges(geometry),[]);
  const wrapped={type:'FeatureCollection',features:[
    {type:'Feature',properties:{},geometry:{type:'Point',coordinates:[0,0]}},
    {type:'Feature',properties:{},geometry:{type:'MultiLineString',coordinates:[[[44,43],[44.1,43]]]}},
  ]};
  assert.equal(routeLineEdges(wrapped).length,2);
});

test('detail widths and territorial prominence are bounded and continuous across the entire zoom range',()=>{
  let previousWidth=0,previousOpacity=1;
  for(let zoom=-2;zoom<=22;zoom+=.125){
    const width=routeStrokeWidth(zoom),opacity=territoryDetailOpacity(zoom);
    assert.ok(width>=3&&width<=5);
    assert.ok(opacity>=.219999&&opacity<=1);
    assert.ok(width>=previousWidth&&opacity<=previousOpacity);
    if(previousWidth)assert.ok(width-previousWidth<.05,'no sudden line-weight jump between zooms');
    previousWidth=width;previousOpacity=opacity;
  }
  assert.ok(Number.isFinite(routeStrokeWidth(NaN)));
  assert.ok(Number.isFinite(territoryDetailOpacity(NaN)));
});

test('the actual cartographic and satellite styles validate against the installed renderer and evaluate at every supported zoom',()=>{
  for(const view of [style,satelliteStyle(style)]){
    assert.deepEqual(spec.validateStyleMin(view),[]);
    for(const [index,layer] of view.layers.entries())for(const [group,properties] of [['paint',layer.paint],['layout',layer.layout]]){
      for(const [key,input] of Object.entries(properties??{})){
        if(!/^(?:line-width|line-opacity|fill-opacity|circle-radius|text-size|text-opacity)$/.test(key))continue;
        const parsed=spec.createExpression(input,`layers[${index}].${group}.${key}`);
        assert.equal(parsed.result,'success',`${layer.id}.${key} must compile`);
        for(let zoom=0;zoom<=18;zoom++){
          const value=parsed.value.evaluateWithoutErrorHandling({zoom},{type:'Point',properties:{}});
          assert.ok(Number.isFinite(value)&&value>=0,`${view.name}: ${layer.id}.${key} at z${zoom}`);
          if(key.endsWith('opacity'))assert.ok(value<=1);
          if(key==='text-size')assert.ok(value>=12&&value<=24,'labels stay within a readable bounded hierarchy');
          if(key==='line-width')assert.ok(value<=16,'detail strokes cannot grow unbounded at maximum zoom');
        }
      }
    }
    assert.ok(view.layers.find(layer=>layer.id==='country-label').maxzoom<=6);
    assert.ok(view.layers.find(layer=>layer.id==='state-label').maxzoom<=9);
    assert.ok(view.layers.find(layer=>layer.id==='path-label').minzoom>=13);
  }
});

test('Canvas styles stay bounded from the country view through street scale in both imagery modes',()=>{
  class Symbolizer{constructor(options){this.options=options;}}
  const p={PolygonSymbolizer:Symbolizer,LineSymbolizer:Symbolizer,CenteredTextSymbolizer:Symbolizer};
  for(const satellite of [false,true])for(const showPaths of [false,true]){
    const view=canvasStyle(p,showPaths,satellite);
    for(let zoom=0;zoom<=18;zoom++)for(const rule of view.paintRules){
      if(zoom<(rule.minzoom??0)||zoom>=(rule.maxzoom??Infinity))continue;
      for(const key of ['width','opacity']){
        const input=rule.symbolizer.options[key];
        if(input===undefined)continue;
        const value=typeof input==='function'?input(zoom):input;
        assert.ok(Number.isFinite(value)&&value>=0,`${key} at z${zoom}`);
        assert.ok(value<=(key==='opacity'?1:16),`${key} stays bounded at z${zoom}`);
      }
    }
    if(satellite)assert.ok(view.paintRules.every(rule=>!['landcover','landuse','park','water','building'].includes(rule.dataLayer)));
  }
});
