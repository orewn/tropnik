import test from 'node:test';
import assert from 'node:assert/strict';
import {surfaceNoise,createSurfaceTexture,createTerrainModel,buildTerrainBoundary,sampleTerrainMeshElevation} from '../public/terrain/terrain-renderer.js';

test('world anchored material repeats continuously, including negative coordinates',()=>{
  for(const period of[4,16,32,64])for(const x of[-31.124,-.00001,0,.73,9.47])for(const y of[-8.25,0,.18,21.36]){
    const a=surfaceNoise(x,y,period,19);
    assert.ok(a>=0&&a<=1);
    assert.ok(Math.abs(a-surfaceNoise(x+period,y-period,period,19))<1e-12);
    assert.ok(Math.abs(surfaceNoise(-1e-6,y,period,19)-surfaceNoise(period+1e-6,y,period,19))<1e-8,'a repeated world coordinate cannot create a texture seam');
  }
});

test('material allocation is deterministic and bounded before GPU upload',()=>{
  const a=createSurfaceTexture(),b=createSurfaceTexture();
  assert.equal(a.pixels.byteLength,65536);assert.deepEqual(a.pixels,b.pixels);
  for(let channel=0;channel<4;channel++){
    const values=new Set();for(let i=channel;i<a.pixels.length;i+=4)values.add(a.pixels[i]);
    assert.ok(values.size>80,'all material channels retain useful variation');
  }
  for(const size of[0,31,63,257,4096,NaN])assert.throws(()=>createSurfaceTexture(size),/bounded/);
});

test('cut rim joins the rendered LOD edge exactly, with no invented top elevations',()=>{
  const width=10,height=7,grid={width,height,bounds:[40,43,40.02,43.02],elevations:Array.from({length:width*height},(_,i)=>100+(i%width)*9+Math.sin(i*.7)*40)};
  const model=createTerrainModel(grid),unchanged=JSON.stringify(grid);
  for(const step of[1,2,4,8]){
    const boundary=buildTerrainBoundary(model,step);
    assert.ok(boundary.triangles<=4*(width+height-2));
    assert.ok(boundary.floor<(model.min-model.base)/model.scale);
    for(let i=0;i<boundary.vertices.length;i+=18){
      const triangle=[0,6,12].map(offset=>Array.from(boundary.vertices.subarray(i+offset,i+offset+3)));
      const rim=triangle.filter(p=>p[2]>boundary.floor+1e-7);
      for(const p of rim){
        const actual=sampleTerrainMeshElevation(model,p[0]*model.scale,p[1]*model.scale,step);
        assert.notEqual(actual,null);
        assert.ok(Math.abs((p[2]*model.scale+model.base)-actual)<.0001,'upper edge must coincide with the exact active mesh');
      }
      for(const p of triangle)assert.ok(Math.abs(Math.abs(p[0])-model.width/2)<1e-7||Math.abs(Math.abs(p[1])-model.height/2)<1e-7,'cut geometry stays only on the four boundary planes');
    }
  }
  assert.equal(JSON.stringify(grid),unchanged);
});
