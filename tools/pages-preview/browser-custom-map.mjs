import assert from 'node:assert/strict';
import {visibleMapBounds} from './map-projection.mjs';

/** Read the public, bounded diagnostic after real rendering; never discover a
 * component/renderer instance or call application methods from the harness. */
export function inspectCustomMapDOM(doc=document){
 const element=doc.querySelector('.atlas-canvas[data-map-engine="tropnik-canvas"]');
 if(!element)return null;
 const raw=element.dataset.mapInspection;if(!raw||raw.length>1000000)return null;
 let inspection;try{inspection=JSON.parse(raw);}catch{return null;}
 const canvas=element.querySelector('canvas.tropnik-map-canvas'),rect=canvas?.getBoundingClientRect();
 return{...inspection,readOnly:true,canvas:canvas&&rect?{connected:canvas.isConnected,width:canvas.width,height:canvas.height,cssWidth:rect.width,cssHeight:rect.height}:null};
}

export function assertCustomMapInspection(value,context,{mode,routeId,settled=true}={}){
 assert.equal(value?.engine,'tropnik-canvas',`${context}: no custom-renderer receipt`);assert.equal(value.readOnly,true);
 assert.equal(value.canvas?.connected,true);for(const key of ['width','height','cssWidth','cssHeight'])assert.ok(Number.isFinite(value.canvas[key])&&value.canvas[key]>1,`${context}: no actual map canvas`);
 assert.ok(Number.isInteger(value.drawRevision)&&value.drawRevision>0,`${context}: no actual draw`);
 assert.ok(Array.isArray(value.camera?.center)&&value.camera.center.length===2&&value.camera.center.every(Number.isFinite));assert.ok(Number.isFinite(value.camera.zoom));
 assert.equal(value.state?.ready,true);assert.equal(value.coverage?.ready,true,`${context}: geographic mask is not ready`);
 if(settled){assert.equal(value.state.loading,false,`${context}: current tiles still loading`);assert.equal(value.state.error,'',`${context}: current source error`);}
 if(mode)assert.equal(value.state.committedMode,mode,`${context}: requested mode was not committed`);
 if(routeId!==undefined){assert.equal(value.routeId,routeId);assert.equal(value.drawnRoute,routeId,`${context}: selected route was not painted`);}
 for(const kind of ['overview','detail','relief','imagery']){
  assert.ok(Array.isArray(value.tiles?.[kind])&&value.tiles[kind].length<=96,`${context}: missing bounded bitmap batch`);
  for(const tile of value.tiles[kind]){
   assert.ok(typeof tile.key==='string'&&tile.key);assert.ok(['z','x','y'].every(key=>Number.isInteger(tile[key]))&&tile.z>=0&&tile.z<=18);
   assert.ok(tile.y>=0&&tile.y<2**tile.z);assert.ok(tile.width>0&&tile.width<=1024&&tile.height>0&&tile.height<=1024);
   assert.ok(Array.isArray(tile.bounds)&&tile.bounds.length===4&&tile.bounds.every(Number.isFinite)&&tile.bounds[0]<tile.bounds[2]&&tile.bounds[1]<tile.bounds[3]);
  }
 }
 assert.ok(Array.isArray(value.labels)&&value.labels.length<=512);
 return value;
}

export function assertCustomDetailInspection(value,context,{routeId}={}){
 const map=assertCustomMapInspection(value,context,{routeId});
 assert.equal(map.state.mode,'detail',`${context}: the detail mode is not selected`);
 if(map.camera.zoom<5){
  assert.equal(map.state.committedMode,'overview',`${context}: low zoom must identify its actual overview ground`);
  assert.ok(map.tiles.overview.length>0,`${context}: the overview ground is missing`);
  for(const kind of ['detail','relief','imagery'])assert.equal(map.tiles[kind].length,0,`${context}: low zoom contains an unexpected ${kind} batch`);
  assert.equal(map.state.reliefReady,false);
 }else{
  assert.equal(map.state.committedMode,'detail',`${context}: close view did not commit vector detail`);
  assert.ok(map.tiles.detail.length>0,`${context}: close view has no vector detail bitmap`);
 }
 return map;
}

export function assertCustomVisibleBounds(frame,requestedBounds,context){
 const map=assertCustomMapInspection(frame.bitmapInspection,context),viewport=map.viewport,padding=viewport?.padding,layout=frame.viewportLayout,rect=frame.rect;
 assert.ok(layout&&Number.isFinite(layout.width)&&Number.isFinite(layout.height)&&layout.width>0&&layout.height>0,`${context}: no actual browser viewport`);
 for(const dimension of ['width','height']){
  assert.ok(Math.abs(viewport?.[dimension]-rect[dimension])<1,`${context}: inspection has stale canvas dimensions`);
  const canvasDimension=dimension==='width'?'cssWidth':'cssHeight';
  assert.ok(Math.abs(map.canvas[canvasDimension]-rect[dimension])<1,`${context}: rendered canvas and map bounds differ`);
 }
 assert.ok(Math.abs(map.camera.center[0]-frame.camera.longitude)<1e-8&&Math.abs(map.camera.center[1]-frame.camera.latitude)<1e-8&&Math.abs(map.camera.zoom-frame.camera.zoom)<1e-8,`${context}: inspection has a stale camera`);
 const expected=visibleMapBounds({...frame.camera,bearingDegrees:map.camera.bearingDegrees??0},rect,padding,map.pitch);
 const visible={left:rect.left+padding.left,right:rect.right-padding.right,top:rect.top+padding.top,bottom:rect.bottom-padding.bottom};
 assert.ok(visible.left>=-1&&visible.right<=layout.width+1&&visible.top>=-1&&visible.bottom<=layout.height+1,`${context}: terrain includes ground outside the browser viewport`);
 if(layout.panel){
  const panel=layout.panel;
  for(const edge of ['left','right','top','bottom'])assert.ok(Number.isFinite(panel[edge]),`${context}: panel bounds are missing`);
  if(panel.right>rect.left&&panel.left<rect.right&&panel.top<rect.bottom&&panel.bottom>rect.top)assert.ok(visible.bottom<=panel.top+1,`${context}: terrain includes ground hidden by the sheet`);
 }
 for(const [label,bounds]of [['inspection',map.visibleBounds],['terrain',requestedBounds]]){
  assert.ok(Array.isArray(bounds)&&bounds.length===4&&bounds.every(Number.isFinite),`${context}: ${label} bounds are missing`);
  for(let index=0;index<4;index++)assert.ok(Math.abs(bounds[index]-expected[index])<1e-6,`${context}: ${label} used another area instead of the unobscured map`);
 }
 return expected;
}

export function assertCustomSceneInspection(value,context){
 assert.equal(value?.schemaVersion,1);assert.equal(value.engine,'tropnik-terrain');assert.equal(value.state,'ready');
 assert.ok(Number.isInteger(value.frames)&&value.frames>0);const {grid,frame,provenance}=value;
 assert.ok(Number.isInteger(grid?.width)&&grid.width>=2&&grid.width<=1025);assert.ok(Number.isInteger(grid.height)&&grid.height>=2&&grid.height<=1025);
 assert.equal(frame?.sourceVertices,grid.width*grid.height);assert.ok(frame.triangles>0);assert.ok(['webgl2','canvas2d'].includes(frame.renderer));
 assert.ok([grid.minElevation,grid.maxElevation].every(Number.isFinite)&&grid.minElevation<=grid.maxElevation);
 assert.ok(Array.isArray(grid.bounds)&&grid.bounds.length===4&&grid.bounds.every(Number.isFinite));assert.deepEqual(grid.bounds,value.requestedBounds);
 assert.ok(grid.bounds[2]>grid.bounds[0]&&grid.bounds[2]-grid.bounds[0]<=360);assert.ok(grid.bounds[3]>grid.bounds[1]);
 assert.ok(typeof grid.source?.name==='string'&&grid.source.name);assert.ok(typeof grid.source.url==='string'&&grid.source.url);
 assert.deepEqual(provenance?.requestedBounds,grid.bounds,`${context}: rendered terrain has another geographic source`);
 assert.ok(['yaw','pitch','zoom'].every(key=>Number.isFinite(frame.view?.[key])));assert.ok(frame.view.zoom>=.65&&frame.view.zoom<=5);
 assert.ok(Array.isArray(frame.view.offset)&&frame.view.offset.length===2&&frame.view.offset.every(Number.isFinite));
 if(value.cartography?.state==='ready'){
  const source=value.cartography.source;assert.equal(value.cartography.width,1024);assert.equal(value.cartography.height,1024);
  assert.deepEqual(source.bounds,grid.bounds);assert.equal(source.projection,'regular-longitude-latitude');assert.equal(source.sampleLayout,'grid-nodes');
  assert.ok(Number.isInteger(source.loadedTiles)&&source.loadedTiles>0&&source.loadedTiles<=16);assert.ok(source.requestedTiles>=source.loadedTiles&&source.requestedTiles<=16);
  assert.equal(frame.cartography?.loadedTiles,source.loadedTiles,`${context}: decoded cartography was never rendered`);
  assert.equal(frame.cartography.requestedTiles,source.requestedTiles);assert.equal(frame.cartography.width,value.cartography.width);assert.equal(frame.cartography.height,value.cartography.height);
 }
 return value;
}
