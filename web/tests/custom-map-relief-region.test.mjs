import test from 'node:test';
import assert from 'node:assert/strict';
import {reliefPixels,elevationBorder} from '../lib/custom-map-painter.ts';
import {reliefPixelsReference} from './fixtures/relief-pixels-204614c.mjs';

const height=(x,y)=>1200+x*x/512-y*y/1024+((x*17+y*13)%31)/8;
const grid=(size,dx=0,dy=0)=>Float32Array.from({length:size*size},(_,index)=>height(index%size+dx*size,Math.floor(index/size)+dy*size));
function fullHalo(size){
 const result={};for(const dy of [-1,0,1])for(const dx of [-1,0,1])if(dx||dy)result[`${dx},${dy}`]=elevationBorder(grid(size,dx,dy),size,size,dx,dy);return result;
}

test('regional shading matches exact crops of the independent full formula at every side, corner and source latitude',()=>{
 for(const size of [2,4,17,256,512])for(const {tileY,z} of [{tileY:0,z:0},{tileY:1300,z:12}]){
  const heights=grid(size),complete=fullHalo(size),missingCorner={...complete};delete missingCorner['1,1'];
  for(const halo of [{},complete,missingCorner]){
   const reference=reliefPixelsReference(heights,size,tileY,z,halo);
   assert.deepEqual(reliefPixels(heights,size,tileY,z,halo),reference,'the ordinary full-source renderer keeps every original byte');
   const regions=[{x:0,y:0,width:1,height:size},{x:size-1,y:0,width:1,height:size},
    {x:0,y:0,width:size,height:1},{x:0,y:size-1,width:size,height:1},
    {x:0,y:0,width:1,height:1},{x:size-1,y:0,width:1,height:1},
    {x:0,y:size-1,width:1,height:1},{x:size-1,y:size-1,width:1,height:1},
    {x:0,y:0,width:size,height:size},
    {x:Math.floor(size/4),y:Math.floor(size/4),width:Math.max(1,Math.floor(size/2)),height:Math.max(1,Math.floor(size/2))}];
   for(const region of regions){
    const actual=reliefPixels(heights,size,tileY,z,halo,region),expected=new Uint8ClampedArray(region.width*region.height*4);
    for(let row=0;row<region.height;row++){
     const offset=((region.y+row)*size+region.x)*4;
     expected.set(reference.subarray(offset,offset+region.width*4),row*region.width*4);
    }
    assert.deepEqual(actual,expected,`exact source pixels for size ${size}, latitude row ${tileY}, region ${JSON.stringify(region)}`);
   }
  }
 }
});

test('invalid pixel regions reject rather than paint shifted or resampled relief',()=>{
 const heights=grid(4);
 for(const region of [{x:-1,y:0,width:1,height:1},{x:0,y:-1,width:1,height:1},
  {x:0,y:0,width:0,height:1},{x:0,y:0,width:1,height:0},{x:0,y:0,width:5,height:1},
  {x:0,y:0,width:1,height:5},{x:3,y:3,width:2,height:1},{x:0,y:0,width:1.5,height:1},
  {x:NaN,y:0,width:1,height:1},{x:0,y:Infinity,width:1,height:1}]){
  assert.throws(()=>reliefPixels(heights,4,0,0,{},region),/pixel region/);
 }
});
