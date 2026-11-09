import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {createLeafletCanvas} from '../lib/leaflet-canvas.ts';

const require=createRequire(import.meta.url);
const leafletSource=readFileSync(require.resolve('leaflet/dist/leaflet-src.js'),'utf8');

// Exercise the installed SDK's actual Canvas/Renderer/Layer lifecycle. The
// only substitutes are DOM painting and a deterministic browser RAF queue.
function harness(){
 const frames=new Map(),contexts=[];let nextFrame=0;
 const document={documentElement:{style:{}},createElement(){
  const context={clears:0,save(){},restore(){},setTransform(){},translate(){},scale(){},beginPath(){},rect(){},clip(){},clearRect(){this.clears++;}};
  contexts.push(context);
  return{style:{},className:'',getContext:()=>context,addEventListener(){},removeEventListener(){}};
 }};
 const navigator={userAgent:'Node Leaflet cleanup regression',platform:'Linux'};
 const window={document,navigator,devicePixelRatio:1,screen:{},addEventListener(){},removeEventListener(){},
  requestAnimationFrame(callback){const id=++nextFrame;frames.set(id,callback);return id;},
  cancelAnimationFrame(id){frames.delete(id);},
 };
 const leaflet={exports:{}};
 vm.runInNewContext(leafletSource,{document,navigator,window,module:leaflet,exports:leaflet.exports,setTimeout:()=>0,clearTimeout(){},console});
 const L=leaflet.exports,pane={appendChild(element){element.parentNode=this;},removeChild(element){element.parentNode=null;}};
 const map=Object.assign(Object.create(L.Map.prototype),{
  _layers:{},_loaded:true,_zoomAnimated:false,
  getPane:()=>pane,getSize:()=>L.point(100,100),containerPointToLayerPoint:point=>point,getCenter:()=>L.latLng(0,0),getZoom:()=>4,
 });
 const path={options:{weight:1},_pxBounds:L.bounds([0,0],[8,8])};
 const flush=()=>{for(const [id,callback] of [...frames])if(frames.delete(id))callback();};
 return{L,map,path,frames,contexts,flush,window};
}

test('installed Leaflet reproduces the lost-RAF clearRect failure after renderer removal',()=>{
 const h=harness(),renderer=h.L.canvas().addTo(h.map);
 renderer._requestRedraw(h.path);const orphaned=renderer._redrawRequest;
 renderer._updatePaths(); // synchronous redraw forgets the first request ID
 renderer._requestRedraw(h.path);const latest=renderer._redrawRequest;
 assert.notEqual(orphaned,latest);
 renderer.remove();
 assert.equal(renderer._ctx,undefined);
 assert.deepEqual([...h.frames.keys()],[orphaned],'SDK removal cancels only the most recent tracked request');
 assert.throws(h.flush,/clearRect/);
});

test('owned Canvas cancels the overwritten request and keeps unrelated RAF work intact',()=>{
 const h=harness(),sdkRedraw=h.L.Canvas.prototype._redraw;
 const renderer=createLeafletCanvas(h.L,{pane:'russia-mask',padding:.15}).addTo(h.map);
 assert.equal(h.L.Canvas.prototype._redraw,sdkRedraw,'The SDK prototype must remain untouched');
 assert.equal(renderer.options.pane,'russia-mask');assert.equal(renderer.options.padding,.15);
 let unrelated=0;h.window.requestAnimationFrame(()=>unrelated++);
 renderer._requestRedraw(h.path);const previous=renderer._redrawRequest;
 renderer._updatePaths();
 assert.equal(h.frames.has(previous),false,'Synchronous redraw must cancel its earlier RAF before resetting the ID');
 renderer._requestRedraw(h.path);renderer.remove();
 assert.equal(renderer._ctx,undefined);
 assert.doesNotThrow(h.flush);assert.doesNotThrow(h.flush);
 assert.equal(unrelated,1,'Disposal must not cancel another renderer or application frame');
 assert.equal(h.frames.size,0);
});

test('a stale callback after disposal is harmless and a re-added renderer still paints',()=>{
 const h=harness(),renderer=createLeafletCanvas(h.L).addTo(h.map),firstContext=renderer._ctx;
 renderer._requestRedraw(h.path);const dispatched=h.frames.get(renderer._redrawRequest);
 renderer.remove();
 assert.equal(h.frames.size,0);
 assert.doesNotThrow(dispatched,'A callback already handed to the browser must not use the destroyed context');
 renderer.addTo(h.map);
 assert.notEqual(renderer._ctx,firstContext,'Leaflet re-add creates a fresh drawing context');
 const before=renderer._ctx.clears;
 renderer._requestRedraw(h.path);h.flush();
 assert.ok(renderer._ctx.clears>before,'The cleanup guard must not leave a reused renderer permanently disabled');
 renderer.remove();assert.doesNotThrow(h.flush);
});
