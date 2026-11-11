import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCustomMapDOM,assertCustomMapInspection,assertCustomSceneInspection} from '../browser-custom-map.mjs';
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
  value=>value.frame.sourceVertices++,value=>value.frame.triangles=0,value=>value.frame.renderer='unknown',
  value=>value.provenance.requestedBounds=[0,0,1,1],value=>value.grid.source.url='',
  value=>value.frame.view.zoom=6,value=>value.frame.view.yaw=NaN,
  value=>value.cartography.source.bounds=[0,0,1,1],value=>value.cartography.source.loadedTiles=17,
  value=>value.frame.cartography=null,value=>value.frame.cartography.width=512,
 ]){const invalid=structuredClone(good);change(invalid);assert.throws(()=>assertCustomSceneInspection(invalid,'invalid'));}
});
