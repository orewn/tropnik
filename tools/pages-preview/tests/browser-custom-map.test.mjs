import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCustomMapDOM,assertCustomMapInspection,assertCustomDetailInspection,assertCustomSceneInspection} from '../browser-custom-map.mjs';
import {settleMapCamera} from '../browser-zoom-audit.mjs';
import {customMapFixture,customSceneFixture} from './custom-map-fixture.mjs';

test('custom inspection uses only the rendered DOM contract and bounds malformed data',()=>{
 const value=customMapFixture(),canvas={isConnected:true,width:1000,height:700,getBoundingClientRect:()=>({width:1000,height:700})};
 const element={dataset:{mapInspection:JSON.stringify(value)},querySelector:selector=>{assert.equal(selector,'canvas.tropnik-map-canvas');return canvas;}};
 const doc={querySelector:selector=>{assert.equal(selector,'.atlas-canvas[data-map-engine="tropnik-canvas"]');return element;}};
 const inspected=inspectCustomMapDOM(doc);assert.equal(assertCustomMapInspection(inspected,'DOM'),inspected);
 for(const raw of ['','{bad','x'.repeat(1000001)]){element.dataset.mapInspection=raw;assert.equal(inspectCustomMapDOM(doc),null);}
 assert.equal(inspectCustomMapDOM({querySelector:()=>null}),null);
});

test('a ready dataset cannot replace actual bitmap, coverage, canvas and painted-route evidence',()=>{
 const good=customMapFixture();assert.equal(assertCustomMapInspection(good,'ready',{routeId:'kavkaz-8a',mode:'detail'}),good);
 for(const change of [
  value=>value.canvas.connected=false,value=>value.canvas.width=0,value=>value.drawRevision=0,
  value=>value.coverage.ready=false,value=>value.state.loading=true,value=>value.state.error='Source failed',
  value=>value.drawnRoute='',value=>value.state.committedMode='overview',value=>delete value.tiles.detail,
  value=>value.tiles.detail=Array(97).fill(value.tiles.detail[0]),value=>value.tiles.detail[0].bounds=[1,1,0,0],
 ]){const invalid=structuredClone(good);change(invalid);assert.throws(()=>assertCustomMapInspection(invalid,'invalid',{routeId:'kavkaz-8a',mode:'detail'}));}
});

test('each selected detail scale must prove its actual overview or vector batch without accepting close-view fallback',()=>{
 for(const zoom of [2,4.999,5,11,18]){
  const actual=customMapFixture({camera:{longitude:40,latitude:43,zoom}});
  assert.equal(assertCustomDetailInspection(actual,'scale'),actual);
  for(const change of [
   value=>value.state.mode='overview',value=>value.state.error='Source failed',
   value=>value.state.committedMode=zoom<5?'detail':'overview',
   value=>{if(zoom<5)value.tiles.overview=[];else value.tiles.detail=[];},
  ]){const invalid=structuredClone(actual);change(invalid);assert.throws(()=>assertCustomDetailInspection(invalid,'bad scale'));}
 }
 const stale=customMapFixture({camera:{longitude:40,latitude:43,zoom:4}});stale.tiles.detail=[customMapFixture().tiles.detail[0]];
 assert.throws(()=>assertCustomDetailInspection(stale,'stale close detail'),/unexpected detail/);
});

test('settling requires four real draws of the current route; only an explicit held preload permits loading',async()=>{
 const state={engine:'tropnik-canvas',visible:true,moving:false,camera:{longitude:40,latitude:43,zoom:14,tileSize:256},rect:{left:0,top:0,width:400,height:700},route:'route',rendering:{painted:true,coverageReady:true,drawnRoute:'route',tilesState:'ready'}};
 const run=async(value,allowLoading=false)=>{let frames=0;const result=await settleMapCamera({engine:'tropnik-canvas',allowLoading,frame:async()=>{frames++;},read:async()=>structuredClone(value),wait:async(_label,read,accept)=>{for(let index=0;index<6;index++){const sample=await read();if(accept(sample))return sample;}throw new Error('Did not settle');}});return{result,frames};};
 assert.equal((await run(state)).frames,4);
 for(const change of [value=>value.rendering.painted=false,value=>value.rendering.coverageReady=false,value=>value.rendering.drawnRoute='',value=>value.rendering.tilesState='loading']){const invalid=structuredClone(state);change(invalid);await assert.rejects(run(invalid),/Did not settle/);}
 const pending=structuredClone(state);pending.rendering.tilesState='loading';assert.equal((await run(pending,true)).frames,4);
 pending.rendering.tilesState='error';await assert.rejects(run(pending,true),/Did not settle/);
});

test('terrain receipt requires its actual geographic grid, mesh, camera and uploaded land-cover texture',()=>{
 const good=customSceneFixture(false).states.initial;assert.equal(assertCustomSceneInspection(good,'terrain'),good);
 for(const change of [
  value=>value.state='loading',value=>value.frames=0,value=>value.grid.width=1026,
  value=>value.schemaVersion=1,value=>value.loadingWindow=true,value=>value.requestedWindowRevision++,value=>value.loadedRequestBounds=[20,42,21,43],value=>value.contextBounds=null,
  value=>value.cartography.source.complete=false,value=>value.cartography.source.kind='vector',value=>value.cartography.width=2049,
  value=>value.provenance.missingDataFilled=true,value=>value.view.distanceM=0,value=>value.frame.geographicView={...value.view,distanceM:1},
  value=>delete value.frame.viewport,value=>value.frame.viewport={...value.viewport,width:value.viewport.width+1},value=>value.frame.viewport.insets.top=NaN,
  value=>value.frame.sourceVertices++,value=>value.frame.triangles=0,value=>value.frame.renderer='unknown',
  value=>delete value.frame.meshWindow,value=>value.frame.meshStride=3,value=>value.frame.renderedVertices++,value=>value.frame.triangles+=2,value=>value.frame.meshWindow=[1,0,200,200],
  value=>value.provenance.requestedBounds=[0,0,1,1],value=>value.grid.source.url='',
  value=>value.frame.view.zoom=1025,value=>value.frame.view.yaw=NaN,
  value=>value.cartography.source.bounds=[0,0,1,1],value=>value.cartography.source.loadedTiles=17,
  value=>value.frame.cartography=null,value=>value.frame.cartography.width=512,
  value=>delete value.displayMask,value=>value.displayMask.state='loading',
  value=>value.displayMask.source.bounds=[0,0,1,1],value=>value.displayMask.source.cells=[],
  value=>value.displayMask.source.allowedPixels=0,value=>value.frame.displayMask=null,
  value=>value.frame.displayMask.coverageVersion='b'.repeat(16),value=>value.frame.displayMask.allowedPixels--,
 ]){const invalid=structuredClone(good);change(invalid);assert.throws(()=>assertCustomSceneInspection(invalid,'invalid'));}
});


test('compatible map mesh receipts prove bounded native sample windows and exact triangle counts',()=>{
 const value=customSceneFixture(false).states.close;
 Object.assign(value.frame,{renderer:'canvas2d',meshStride:2,meshWindow:[160,192,496,368],renderedVertices:15041,triangles:29568});
 assert.equal(assertCustomSceneInspection(value,'close canvas'),value);
 for(const change of[
  scene=>scene.frame.meshWindow=null,
  scene=>scene.frame.meshWindow=[160,192,496,scene.grid.height],
  scene=>scene.frame.meshWindow=[161,192,497,368],
  scene=>{const f=scene.frame;f.meshWindow=[0,0,scene.grid.width-1,scene.grid.height-1];const columns=Math.ceil((scene.grid.width-1)/f.meshStride)+1,rows=Math.ceil((scene.grid.height-1)/f.meshStride)+1;f.renderedVertices=columns*rows;f.triangles=(columns-1)*(rows-1)*2;},
 ]){const bad=structuredClone(value);change(bad);assert.throws(()=>assertCustomSceneInspection(bad,'bad window'));}
});
