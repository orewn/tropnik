import test from 'node:test';
import assert from 'node:assert/strict';
import {rasterizeTerrainExclusions,createRussiaTerrainMask,TERRAIN_MASK_LIMITS} from '../lib/terrain-display-mask.ts';
import {validateTerrainDisplayMask,sampleTerrainDisplayMask} from '../public/terrain/terrain-renderer.js';

const rectangle=(w,s,e,n)=>[[w,s],[e,s],[e,n],[w,n],[w,s]];
const feature=(rings,properties={role:'mask'})=>({type:'Feature',properties,geometry:{type:'Polygon',coordinates:rings}});
const fc=features=>({type:'FeatureCollection',features});
const at=(pixels,x,y,w=32)=>pixels[y*w+x];
const options={width:32,height:32,yield:async()=>{}};

test('complement polygons hide the coast while their holes remain allowed land',async()=>{
  const geometry=fc([feature([rectangle(0,0,10,10),rectangle(2,2,8,8)])]),unchanged=JSON.stringify(geometry);
  const pixels=await rasterizeTerrainExclusions(geometry,[0,0,10,10],options);
  assert.equal(at(pixels,16,16),255,'a hole of the excluded polygon is allowed land');
  assert.equal(at(pixels,2,16),0);assert.equal(at(pixels,30,16),0);assert.equal(at(pixels,16,2),0);assert.equal(at(pixels,16,30),0);
  assert.equal(at(pixels,6,16),0,'a pixel intersecting the actual coastline is conservatively hidden');
  assert.equal(at(pixels,7,16),255);assert.equal(JSON.stringify(geometry),unchanged);
});

test('small excluded holes and narrow coast crossings cannot leak through pixel-centre sampling',async()=>{
  const tiny=feature([rectangle(5.01,5.01,5.02,5.02)]),diagonal=feature([[[0,0],[10,10],[10,9.99],[0,0]]]);
  const pixels=await rasterizeTerrainExclusions(fc([tiny]),[0,0,10,10],{...options,width:10,height:10});
  assert.equal(at(pixels,5,4,10),0,'a hole much smaller than a texel still masks the intersected cell');
  assert.equal(pixels.filter(value=>value===0).length,1);assert.equal(at(pixels,4,4,10),255);
  const crossing=await rasterizeTerrainExclusions(fc([diagonal]),[0,0,10,10],{...options,width:10,height:10});
  for(let x=0;x<10;x++)assert.equal(at(crossing,x,9-x,10),0);
  assert.equal(at(crossing,0,0,10),255);assert.equal(at(crossing,9,9,10),255);
});

test('overlapping excluded polygons combine as a union and geographic cell edges never create land cracks',async()=>{
  const left=feature([[[0,0],[5,0],[5,2],[2,2],[2,8],[5,8],[5,10],[0,10],[0,0]]]);
  const right=feature([[[5,0],[10,0],[10,10],[5,10],[5,8],[8,8],[8,2],[5,2],[5,0]]]);
  // The two outside pieces share only their real excluded parts of the cell
  // edge. The allowed corridor across x=5 remains continuous.
  const pixels=await rasterizeTerrainExclusions(fc([left,right]),[0,0,10,10],options);
  assert.equal(at(pixels,15,16),255);assert.equal(at(pixels,16,16),255);
  assert.equal(at(pixels,15,2),0);assert.equal(at(pixels,16,2),0);
  const overlap=await rasterizeTerrainExclusions(fc([feature([rectangle(0,0,6,10)]),feature([rectangle(4,0,10,10)])]),[0,0,10,10],options);
  assert.ok(overlap.every(value=>value===0),'overlap must not XOR back into allowed terrain');
});

test('canonical dateline coordinates and continuous 179…181 geometry produce identical masks',async()=>{
  const canonical=fc([feature([[[179,0],[-179,0],[-179,2],[179,2],[179,0]]])]);
  const continuous=fc([feature([rectangle(179,0,181,2)])]);
  const a=await rasterizeTerrainExclusions(canonical,[178,-1,182,3],options),b=await rasterizeTerrainExclusions(continuous,[178,-1,182,3],options);
  assert.deepEqual(a,b);assert.equal(at(a,16,16),0);assert.equal(at(a,2,16),255);assert.equal(at(a,29,16),255);
  const shifted=fc([feature([rectangle(179,0,181,2)],{role:'mask',terrainWorldShift:-360})]);
  assert.deepEqual(await rasterizeTerrainExclusions(shifted,[-182,-1,-178,3],options),a);
});

test('raster preparation validates memory, closed rings and coordinates, and aborts at bounded work slices',async()=>{
  await assert.rejects(rasterizeTerrainExclusions(fc([]),[0,0,1,1],{width:2049,height:32}),/pixel budget/);
  await assert.rejects(rasterizeTerrainExclusions(fc([feature([[[0,0],[1,0],[1,1],[0,1]]])]),[0,0,1,1],options),/Unclosed/);
  await assert.rejects(rasterizeTerrainExclusions(fc([feature([[[0,0],[NaN,0],[1,1],[0,0]]])]),[0,0,1,1],options),/coordinate/);
  const controller=new AbortController();let yields=0;
  const ring=Array.from({length:6000},(_,index)=>[5+2*Math.cos(index/6000*Math.PI*2),5+2*Math.sin(index/6000*Math.PI*2)]);ring.push(ring[0]);
  await assert.rejects(rasterizeTerrainExclusions(fc([feature([ring])]),[0,0,10,10],{...options,signal:controller.signal,yield:async()=>{yields++;controller.abort();}}),{name:'AbortError'});
  assert.equal(yields,1);assert.equal(TERRAIN_MASK_LIMITS.size**2,4*1024*1024);
});

function coverageFixture({bounds=[0,0,10,10],cells,missing=false,ready=true,error='',geometry,gate}={}){
  cells??=[{id:'cell',bounds,levels:{}}];const calls=[];
  const map=new Map(cells.map(cell=>[cell.id,[geometry??feature([rectangle(...cell.bounds)],{role:'area',cell:cell.id})]]));if(missing)map.clear();
  const coverage={manifest:{cells},version:'a'.repeat(16),cellFeatures:map,status:{ready,pending:0,error,lod:'source'},
    async updateView(b,z){calls.push({bounds:[...b],zoom:z});if(gate)await gate;},dispose(){this.disposed=true;}};
  return{coverage,calls,options:{...options,loadCoverage:async()=>coverage}};
}

test('display readiness requires complete verified coverage and never substitutes missing cells with permission',async()=>{
  const env=coverageFixture({geometry:feature([rectangle(0,0,10,10),rectangle(2,2,8,8)])});
  const mask=await createRussiaTerrainMask([0,0,10,10],env.options);
  assert.equal(validateTerrainDisplayMask(mask,{bounds:[0,0,10,10]}),mask);assert.equal(env.coverage.disposed,true);
  assert.equal(sampleTerrainDisplayMask(mask,.5,.5),true);assert.equal(sampleTerrainDisplayMask(mask,.05,.5),false);
  assert.ok(mask.source.allowedPixels>0&&mask.source.allowedPixels<1024);
  for(const setup of[{missing:true},{ready:false},{error:'coverage-integrity'},{cells:[{id:'west',bounds:[0,0,4,10],levels:{}},{id:'east',bounds:[6,0,10,10],levels:{}}]}]){
    const broken=coverageFixture(setup);await assert.rejects(createRussiaTerrainMask([0,0,10,10],broken.options),/mask/);assert.equal(broken.coverage.disposed,true);
  }
});

test('the country overview requests only overview LOD while a local scene selects source detail',async()=>{
  for(const [bounds,expected] of [[[19.6389,41.18,191.01,81.86],4],[[179.1,64,179.2,64.1],14]]){
    const env=coverageFixture({bounds:[0,-85,360,85]});
    await createRussiaTerrainMask(bounds,{...env.options,width:2048,height:2});assert.equal(env.calls[0].zoom,expected);
  }
});

test('cancelled or late source preparation disposes its coverage and cannot yield a ready mask',async()=>{
  const controller=new AbortController();let finish;const gate=new Promise(resolve=>{finish=resolve;}),env=coverageFixture({gate});
  const pending=createRussiaTerrainMask([0,0,10,10],{...env.options,signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();finish();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(env.coverage.disposed,true);
});

test('display mask metadata, size, alignment and binary ownership are independently validated by the renderer',async()=>{
  const env=coverageFixture(),mask=await createRussiaTerrainMask([0,0,10,10],env.options);
  for(const change of[m=>m.width=2049,m=>m.pixels=new Uint8Array(1),m=>m.pixels[0]=127,m=>m.source.bounds[0]=.1,m=>m.source.sampleLayout='grid-nodes',m=>m.source.coverageVersion='unknown',m=>m.source.cells=[],m=>m.source.allowedPixels--]){
    const bad=structuredClone(mask);change(bad);assert.throws(()=>validateTerrainDisplayMask(bad,{bounds:[0,0,10,10]}),/mask/);
  }
  assert.equal(sampleTerrainDisplayMask(mask,-.01,.5),false);assert.equal(sampleTerrainDisplayMask(mask,.5,NaN),false);assert.equal(sampleTerrainDisplayMask(mask,1,1),true);
});
