import test from 'node:test';
import assert from 'node:assert/strict';
import {TerrainRenderer} from '../../../web/public/terrain/terrain-renderer.js';
import {compareTerrainWindowPixels,runTerrainWindowCase} from './terrain-window-fixture.mjs';

function witnesses(){
 const width=512,height=384,pixels=new Uint8Array(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels.set(x>256?[223,230,218,255]:x===100?[189,77,31,255]:[40,70,140,255],(y*width+x)*4);
 return{width,height,pixels};
}
test('map window pixel comparison rejects a changed channel, blank terrain and missing mask or route witnesses',()=>{
 const full=witnesses(),same=structuredClone(full);assert.equal(compareTerrainWindowPixels(full,same).differentPixels,0);
 same.pixels[128*512*4+100*4]++;assert.throws(()=>compareTerrainWindowPixels(full,same),/changed map pixels/);
 for(const color of[[223,230,218,255],[40,70,140,255]]){
  const blank=witnesses();for(let i=0;i<blank.pixels.length;i+=4)blank.pixels.set(color,i);
  assert.throws(()=>compareTerrainWindowPixels(blank,blank),/witnesses/);
 }
 assert.throws(()=>compareTerrainWindowPixels(full,{...full,width:256}),/Invalid/);
});

test('map-only fixture compares actual production Canvas pixels for all three full/window source meshes',async()=>{
 const originals=new Map(['document','requestAnimationFrame','cancelAnimationFrame'].map(key=>[key,globalThis[key]]));
 const make=tag=>{
  let image;const context={createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),putImageData:value=>{image=value;},getImageData:()=>({data:image.data.slice()})};
  return{tag,style:{},dataset:{},children:[],width:0,height:0,parentNode:null,
   appendChild(child){child.parentNode=this;this.children.push(child);},querySelector(name){return this.children.find(child=>child.tag===name);},
   remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;},
   getContext:type=>type==='2d'?context:null,getBoundingClientRect:()=>({width:512,height:384,left:0,top:0}),
   addEventListener(){},removeEventListener(){},toDataURL:()=> 'data:image/png;base64,',
  };
 };
 const body=make('body');globalThis.document={body,createElement:make,visibilityState:'visible',addEventListener(){},removeEventListener(){}};
 globalThis.requestAnimationFrame=callback=>setTimeout(callback,0);globalThis.cancelAnimationFrame=clearTimeout;
 try{
  // This test checks raw production raster pixels. Browser PNG, WebGL and
  // trusted context events are checked by terrain-mask.browser.mjs instead.
  const result=await runTerrainWindowCase(TerrainRenderer,{forceCanvas:true});assert.equal(result.verified,true,result.error);
  assert.equal(result.comparisons.length,3);assert.equal(result.captures.length,6);assert.equal(result.sourceHeightsUnchanged,true);assert.equal(body.children.length,0);
 }finally{for(const[key,value]of originals)if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});
