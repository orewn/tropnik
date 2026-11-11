import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTerrainGrid,createTerrainModel,terrainRoute} from '../public/terrain/terrain-renderer.js';

const grid=bounds=>({schemaVersion:1,bounds,width:9,height:9,elevations:Array.from({length:81},(_,i)=>100+i%9*3+Math.floor(i/9)*2),minElevation:100,maxElevation:140});

test('dateline grids and canonical source routes describe the same continuous terrain',()=>{
 const source={type:'LineString',coordinates:[[179.94,.02],[-179.94,.08]]},before=JSON.stringify(source);
 for(const offset of [-360,0,360]){
  const model=createTerrainModel(grid([179.9+offset,0,180.1+offset,.1]));
  const wrapped=terrainRoute(model,source),unwrapped=terrainRoute(model,{type:'LineString',coordinates:[[179.94+offset,.02],[180.06+offset,.08]]});
  assert.ok(wrapped.segments.length>0);assert.equal(wrapped.clipped,false);assert.equal(wrapped.sourceSegments,1);
  assert.deepEqual(wrapped,unwrapped);
  for(const segment of wrapped.segments)for(const point of segment){assert.ok(point.every(Number.isFinite));assert.ok(Math.abs(point[0])<=model.width/2);assert.ok(Math.abs(point[1])<=model.height/2);}
 }
 assert.equal(JSON.stringify(source),before);
});

test('crossing source segments remain clipped precisely at dateline grid edges',()=>{
 const model=createTerrainModel(grid([179.9,0,180.1,.1]));
 const route=terrainRoute(model,{type:'LineString',coordinates:[[179.8,.05],[-179.8,.05]]});
 assert.equal(route.clipped,true);assert.ok(route.segments.length>0);
 assert.ok(Math.abs(route.segments[0][0][0]+model.width/2)<1e-9);
 assert.ok(Math.abs(route.segments.at(-1)[1][0]-model.width/2)<1e-9);
});

test('continuous longitude support retains size, latitude and source-value validation',()=>{
 for(const bounds of [[0,0,361,1],[180,0,179,1],[0,-86,1,1],[0,0,1,86],[NaN,0,1,1],[0,0,Infinity,1]])assert.throws(()=>validateTerrainGrid(grid(bounds)),/bounds/);
 const invalid=grid([179,0,181,1]);invalid.elevations[1]=NaN;assert.throws(()=>validateTerrainGrid(invalid),/elevation/);
 const wrongSize=grid([179,0,181,1]);wrongSize.elevations.pop();assert.throws(()=>validateTerrainGrid(wrongSize),/grid/);
 const model=createTerrainModel(grid([179.9,0,180.1,.1]));
 assert.deepEqual(terrainRoute(model,{type:'LineString',coordinates:[[179.95,NaN],[-179.95,.05]]}),{segments:[],clipped:true,sourceSegments:1});
});
