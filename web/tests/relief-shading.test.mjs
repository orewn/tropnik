import test from 'node:test';
import assert from 'node:assert/strict';
import {shadeTerrarium} from '../public/maps/relief-shading.js';

function image(size,heightAt){
 const data=new Uint8ClampedArray(size*size*4);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const q=Math.round((heightAt(x,y)+32768)*256),i=(y*size+x)*4;
  data[i]=q>>16;data[i+1]=(q>>8)&255;data[i+2]=q&255;data[i+3]=255;
 }
 return data;
}
test('flat DEM does not fabricate topographic shadows in the detailed map',()=>{
 const result=shadeTerrarium(image(512,()=>600),512,512,1493,12,false);
 assert.equal(result.width,256);assert.equal(result.height,256);
 for(let i=3;i<result.pixels.length;i+=4)assert.equal(result.pixels[i],0);
});
test('opposite physical slopes receive different illumination; downsizing averages heights across RGB carries',()=>{
 const light=shadeTerrarium(image(512,(x)=>256+x*3),512,512,1493,12,false);
 const shade=shadeTerrarium(image(512,(x)=>256-x*3),512,512,1493,12,false);
 const i=(128*256+128)*4;
 assert.ok(light.pixels[i+3]>0);assert.ok(shade.pixels[i+3]>0);
 assert.notEqual(light.pixels[i],shade.pixels[i]);
 const overview=shadeTerrarium(image(512,()=>256),512,512,1,4,true);
 assert.deepEqual([...overview.pixels.slice(0,4)],[...overview.pixels.slice(i,i+4)]);
 assert.equal(overview.pixels[3],255);
});
test('unsupported raster payloads and invalid tile coordinates fail before allocating a map texture',()=>{
 assert.throws(()=>shadeTerrarium(new Uint8ClampedArray(16),512,512,0,4));
 assert.throws(()=>shadeTerrarium(image(2,()=>0),2,2,16,4));
 assert.throws(()=>shadeTerrarium(image(2,()=>0),2,2,0,25));
});
