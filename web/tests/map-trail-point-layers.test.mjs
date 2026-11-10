import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mapTrailPointLayers} from '../lib/map-trail-points.ts';
import {MAP_CONFIG} from '../lib/map-config.ts';

// Exercise the installed SDK's real style compiler and shader cache classifier.
// Only this test module exposes its internals; no SDK or application bundle is patched.
const sdkSource=await readFile(new URL('../node_modules/maplibre-gl/dist/maplibre-gl-dev.mjs',import.meta.url),'utf8');
const sdk=await import('data:text/javascript;base64,'+Buffer.from(sdkSource+
  '\nexport {CircleStyleLayer, EvaluationParameters, ProgramConfiguration};\n//# sourceURL=maplibre-pinned-style-compiler.mjs\n').toString('base64'));
const packageJSON=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const parameters=new sdk.EvaluationParameters(6.1);
const source='trail-points';
const next=mapTrailPointLayers(source,MAP_CONFIG.trailHitRadiusPx);
// Previous style is an independent semantic reference, including its data-driven paint.
const previous=[
  {id:'trail-point-halo',type:'circle',source,paint:{
    'circle-radius':['case',['==',['get','selected'],true],11,9],
    'circle-color':'#FFFEFA','circle-opacity':.98,'circle-pitch-alignment':'viewport','circle-pitch-scale':'viewport',
  }},
  {id:'trail-point-dot',type:'circle',source,paint:{
    'circle-radius':['case',['==',['get','selected'],true],7.5,6],
    'circle-color':['case',['==',['get','selected'],true],'#244D3C','#A56736'],
    'circle-stroke-color':['case',['==',['get','selected'],true],'#A56736','#876A43'],
    'circle-stroke-width':['case',['==',['get','selected'],true],2,1],
    'circle-pitch-alignment':'viewport','circle-pitch-scale':'viewport',
  }},
  {id:'trail-point-hit',type:'circle',source,paint:{
    'circle-radius':22,'circle-color':'#000000','circle-opacity':.001,'circle-stroke-opacity':0,
    'circle-pitch-alignment':'viewport','circle-pitch-scale':'viewport',
  }},
];
function compile(spec){
  const layer=new sdk.CircleStyleLayer(spec,{});
  layer.recalculate(parameters,[]);
  return {layer,configuration:new sdk.ProgramConfiguration(layer,parameters.zoom,()=>true)};
}
const oldCompiled=previous.map(compile),newCompiled=next.map(compile);
function paintValues(layer,feature){
  const values={};
  // Include defaults as well as explicit properties: opacity, blur, stroke and pitch all matter.
  for(const name in layer.paint._values){
    const value=layer.paint.get(name);
    values[name]=typeof value?.evaluate==='function'?value.evaluate(feature,{}):value;
  }
  return values;
}

test('pinned MapLibre compiles the point layers into one uniform circle variant instead of three',()=>{
  assert.equal(sdk.getVersion(),packageJSON.dependencies['maplibre-gl']);
  assert.equal(new Set(oldCompiled.map(item=>item.configuration.cacheKey)).size,3);
  const keys=new Set(newCompiled.map(item=>item.configuration.cacheKey));
  assert.equal(keys.size,1);
  assert.equal([...keys][0],oldCompiled[2].configuration.cacheKey);
  assert.doesNotMatch([...keys][0],/\/[az]_/);
});

test('compiled selection filters preserve all circle paint for true, false and missing selection',()=>{
  for(const properties of [{selected:true},{selected:false},{},{selected:null},{selected:1},{selected:'true'}]){
    const feature={type:'Point',properties};
    const active=newCompiled.filter(({layer})=>layer._featureFilter.filter(parameters,feature));
    assert.equal(active.length,3,JSON.stringify(properties));
    for(const role of ['halo','dot','hit']){
      const matches=active.filter(({layer})=>layer.id===`trail-point-${role}`||layer.id===`trail-point-${role}-selected`);
      assert.equal(matches.length,1,`${role}: ${JSON.stringify(properties)}`);
      const old=oldCompiled.find(({layer})=>layer.id===`trail-point-${role}`);
      assert.deepEqual(paintValues(matches[0].layer,feature),paintValues(old.layer,feature),`${role}: ${JSON.stringify(properties)}`);
    }
  }
});

test('point layers keep halos below dots and preserve the unsplit 44px hit layer and source',()=>{
  assert.deepEqual(next.map(layer=>layer.id),[
    'trail-point-halo','trail-point-halo-selected','trail-point-dot','trail-point-dot-selected','trail-point-hit',
  ]);
  assert.ok(next.every(layer=>layer.source===source));
  assert.deepEqual(next.at(-1),previous.at(-1));
  assert.equal(next.at(-1).paint['circle-radius']*2,44);
});
