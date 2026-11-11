import test from 'node:test';
import assert from 'node:assert/strict';
import {terrainMaskFixture,inspectTerrainMaskPixels,assertTerrainMaskPixels,runTerrainMaskCase} from './terrain-mask-fixture.mjs';

const frame=(paint)=>{
 const width=64,height=64,pixels=new Uint8Array(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels.set([...paint(x,y),255],(y*width+x)*4);
 return{width,height,pixels};
};
function witnesses(){
 const sky=[223,230,218],blue=[5,5,250],reference=frame(x=>x<32?blue:[250,5,5]),empty=frame(()=>sky),terrain=frame(x=>x<32?blue:sky);
 const route=frame((x,y)=>y>=10&&y<50&&x>=6&&x<=12?(x>=8&&x<=10?[189,77,31]:[255,251,232]):x<32?blue:sky);
 return{reference,empty,terrain,route};
}
test('synthetic coverage has an island, an internal hole and a route through both boundaries',()=>{
 const {grid,mask,cartography,geometry}=terrainMaskFixture(),known=mask('known');
 assert.deepEqual(known.source.bounds,grid.bounds);assert.equal(known.source.allowedPixels,known.pixels.filter(value=>value===255).length);
 assert.equal(known.pixels[32*64+16],255);assert.equal(known.pixels[32*64+30],0);assert.equal(known.pixels[32*64+55],0);
 assert.equal(mask('empty').source.allowedPixels,0);assert.equal(mask('full').source.allowedPixels,64*64);
 assert.equal(cartography.pixels.length,1024*1024*4);assert.equal(geometry.coordinates.length,2);
});
test('pixel gate accepts visible allowed terrain and both real route colours with no outside paint',()=>{
 const result=inspectTerrainMaskPixels(witnesses());assertTerrainMaskPixels(result);
 assert.ok(result.outsideWitnesses>1000&&result.insideWitnesses>1000);assert.ok(result.routeCorePixels>50&&result.routeHaloPixels>50);
});
test('one interior terrain leak or one pale route-halo leak fails the pixel gate',()=>{
 for(const field of ['terrain','route']){
  const images=witnesses();images[field].pixels.set(field==='route'?[255,251,232,255]:[120,160,90,255],(32*64+55)*4);
  assert.throws(()=>assertTerrainMaskPixels(inspectTerrainMaskPixels(images)),/paint escaped/);
 }
});
test('blank output and a fully hidden route cannot pass by having zero outside pixels',()=>{
 const blank=witnesses();blank.terrain=blank.empty;blank.route=blank.empty;
 assert.throws(()=>assertTerrainMaskPixels(inspectTerrainMaskPixels(blank)),/allowed terrain/);
 const noRoute=witnesses();noRoute.route=noRoute.terrain;
 assert.throws(()=>assertTerrainMaskPixels(inspectTerrainMaskPixels(noRoute)),/thick route/);
});
test('pixel inspection rejects incomplete or differently sized captures',()=>{
 const images=witnesses();images.route={...images.route,width:63};
 assert.throws(()=>inspectTerrainMaskPixels(images),/Invalid route pixel frame/);
});
test('graphics fallback reads the attached canvas and still fails the required WebGL gate',async()=>{
 const previous=globalThis.document;
 const makeNode=tag=>({tag,style:{},width:512,height:384,children:[],parent:null,
  appendChild(child){child.parent=this;this.children.push(child);},
  querySelector(name){return this.children.find(child=>child.tag===name)||null;},
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;},
  getContext(name){return name==='2d'&&this.software?{getImageData:()=>({data:new Uint8ClampedArray(this.width*this.height*4)})}:null;},
  toDataURL(){return 'data:image/png;base64,';}
 });
 const body=makeNode('body');globalThis.document={body,createElement:makeNode};
 class ReplacingRenderer{
  constructor(original,grid,options){
   this.original=original;this.host=original.parent;original.remove();
   this.visible=makeNode('canvas');this.visible.software=true;this.host.appendChild(this.visible);
   queueMicrotask(()=>options.onRender({renderer:'canvas2d',view:{}}));
  }
  setCartography(){}
  destroy(){this.visible.remove();this.host.appendChild(this.original);}
 }
 try{
  const result=await runTerrainMaskCase(ReplacingRenderer);
  assert.equal(result.verified,false);
  assert.match(result.error,/Expected webgl2, received canvas2d/);
  assert.doesNotMatch(result.error,/getImageData|TypeError: Cannot read properties/);
  assert.equal(body.children.length,0,'failed fixture must release the replacement surface');
 }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
