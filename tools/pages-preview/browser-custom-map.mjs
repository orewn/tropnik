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

export function assertCustomVisibleBounds(frame,scene,context){
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
 const contextBounds=Array.isArray(scene)?scene:scene?.contextBounds;
 for(const [label,bounds]of [['inspection',map.visibleBounds],['terrain context',contextBounds]]){
  assert.ok(Array.isArray(bounds)&&bounds.length===4&&bounds.every(Number.isFinite),`${context}: ${label} bounds are missing`);
  for(let index=0;index<4;index++)assert.ok(Math.abs(bounds[index]-expected[index])<1e-6,`${context}: ${label} used another area instead of the unobscured map`);
 }
 if(!Array.isArray(scene)){
  assert.equal(scene?.schemaVersion,2);assert.equal(scene.navigation,'continuous-map');
  assert.ok(validTerrainBounds(scene.loadedRequestBounds),`${context}: no committed guarded DEM request`);
  assert.ok(containsTerrainBounds(scene.grid?.bounds,scene.loadedRequestBounds),`${context}: rendered DEM does not cover its committed request`);
 }
 return expected;
}

function validTerrainBounds(bounds){return Array.isArray(bounds)&&bounds.length===4&&bounds.every(Number.isFinite)&&bounds[0]<bounds[2]&&bounds[2]-bounds[0]<=360&&bounds[1]<bounds[3]&&bounds[1]>=-85&&bounds[3]<=85;}
function containsTerrainBounds(outer,inner){return validTerrainBounds(outer)&&validTerrainBounds(inner)&&inner[0]>=outer[0]-1e-8&&inner[1]>=outer[1]-1e-8&&inner[2]<=outer[2]+1e-8&&inner[3]<=outer[3]+1e-8;}

export function assertCustomSceneInspection(value,context){
 assert.equal(value?.schemaVersion,2,`${context}: terrain receipt predates continuous navigation`);assert.equal(value.engine,'tropnik-terrain');assert.equal(value.navigation,'continuous-map');assert.equal(value.state,'ready');
 assert.equal(value.loadingWindow,false,`${context}: replacement DEM window is still loading`);
 assert.ok(Number.isInteger(value.windowRevision)&&value.windowRevision>0);assert.equal(value.requestedWindowRevision,value.windowRevision,`${context}: requested window was never committed`);
 assert.ok(Number.isInteger(value.frames)&&value.frames>0);const {grid,frame,provenance}=value;
 assert.ok(Number.isInteger(grid?.width)&&grid.width>=2&&grid.width<=1025);assert.ok(Number.isInteger(grid.height)&&grid.height>=2&&grid.height<=1025);
 assert.ok(grid.width*grid.height<=1050625);assert.equal(frame?.sourceVertices,grid.width*grid.height);assert.ok(frame.triangles>0);assert.ok(['webgl2','canvas2d'].includes(frame.renderer));
 assert.ok(Number.isInteger(frame.meshStride)&&frame.meshStride>=1&&Number.isInteger(Math.log2(frame.meshStride)),`${context}: mesh stride is not a real source sampling level`);
 const sampleWindow=frame.meshWindow===null?[0,0,grid.width-1,grid.height-1]:frame.meshWindow;
 assert.ok(Array.isArray(sampleWindow)&&sampleWindow.length===4&&sampleWindow.every(Number.isInteger),`${context}: mesh sample window is missing`);
 assert.ok(sampleWindow[0]>=0&&sampleWindow[1]>=0&&sampleWindow[2]<grid.width&&sampleWindow[3]<grid.height&&sampleWindow[0]<sampleWindow[2]&&sampleWindow[1]<sampleWindow[3],`${context}: mesh window leaves the measured source`);
 assert.ok(sampleWindow[0]%frame.meshStride===0&&sampleWindow[1]%frame.meshStride===0&&(sampleWindow[2]===grid.width-1||sampleWindow[2]%frame.meshStride===0)&&(sampleWindow[3]===grid.height-1||sampleWindow[3]%frame.meshStride===0),`${context}: cropped geometry has shifted source samples`);
 const columns=Math.ceil((sampleWindow[2]-sampleWindow[0])/frame.meshStride)+1,rows=Math.ceil((sampleWindow[3]-sampleWindow[1])/frame.meshStride)+1;
 assert.equal(frame.renderedVertices,columns*rows,`${context}: reported mesh does not match its actual source sample window`);
 assert.equal(frame.triangles,(columns-1)*(rows-1)*2,`${context}: triangle count does not match the rendered source mesh`);
 assert.ok(frame.renderedVertices<=(frame.renderer==='canvas2d'?16641:263169),`${context}: terrain exceeds its fixed geometry budget`);
 assert.ok(frame.meshWindow,`${context}: map rendering must identify its actual source sample window`);
 assert.ok([grid.minElevation,grid.maxElevation].every(Number.isFinite)&&grid.minElevation>=-12000&&grid.maxElevation<=10000&&grid.minElevation<=grid.maxElevation);
 for(const bounds of[grid.bounds,value.contextBounds,value.requestedBounds,value.loadedRequestBounds])assert.ok(validTerrainBounds(bounds),`${context}: invalid geographic extent`);
 assert.deepEqual(value.requestedBounds,value.loadedRequestBounds,`${context}: reported request belongs to another window`);
 assert.ok(containsTerrainBounds(grid.bounds,value.loadedRequestBounds),`${context}: native DEM does not cover the committed request`);
 assert.match(grid.source?.name,/Copernicus|GLO-30/);assert.ok(typeof grid.source.url==='string'&&/^https:\/\//.test(grid.source.url));
 assert.doesNotMatch(grid.source.url,/openstreetmap|openfreemap|opentopomap/i);
 assert.deepEqual(provenance?.requestedBounds,value.loadedRequestBounds,`${context}: rendered terrain has another geographic source`);
 assert.ok(['remote-terrarium','local-terrarium','local-grid'].includes(provenance.kind));assert.equal(provenance.missingDataFilled,false);assert.equal(provenance.measurementAccuracyClaimedM,null);
 assert.ok(Number.isFinite(provenance.sourceNominalResolutionM)&&provenance.sourceNominalResolutionM>0);
 assert.ok(Array.isArray(provenance.sourceUrls)&&provenance.sourceUrls.length>0&&provenance.sourceUrls.length<=16);
 assert.ok(provenance.sourceUrls.every(url=>typeof url==='string'&&url.length>0&&!/openstreetmap|openfreemap|opentopomap/i.test(url)));
 for(const spacing of[grid.sampleSpacingApproxM,provenance.outputSpacingApproxM])assert.ok(['eastWest','northSouth'].every(key=>Number.isFinite(spacing?.[key])&&spacing[key]>0));
 assert.deepEqual(frame.geographicView,value.view,`${context}: geographic camera does not belong to the completed frame`);
 assert.deepEqual(frame.viewport,value.viewport,`${context}: viewport does not belong to the completed frame`);
 for(const dimension of['width','height'])assert.ok(Number.isFinite(frame.viewport?.[dimension])&&frame.viewport[dimension]>0,`${context}: completed canvas size is missing`);
 for(const edge of['top','right','bottom','left'])assert.ok(Number.isFinite(frame.viewport?.insets?.[edge])&&frame.viewport.insets[edge]>=0,`${context}: completed camera inset is missing`);
 assert.ok(frame.viewport.insets.left+frame.viewport.insets.right<=frame.viewport.width*.88+1e-7&&frame.viewport.insets.top+frame.viewport.insets.bottom<=frame.viewport.height*.88+1e-7,`${context}: camera insets were not clamped to the rendered projection`);
 assert.deepEqual(value.view?.bounds,grid.bounds);assert.ok(['longitude','latitude','yaw','pitch','distanceM','zoom'].every(key=>Number.isFinite(value.view[key])));
 assert.ok(value.view.distanceM>0);assert.ok(value.view.latitude>=41.1858711-1e-8&&value.view.latitude<=81.858721+1e-8);
 assert.ok(value.view.longitude>=19.6389282-1e-8&&value.view.longitude<=191.0026658+1e-8);
 const mask=value.displayMask,maskSource=mask?.source;
 assert.equal(mask?.state,'ready',`${context}: actual geographic display mask is not ready`);
 for(const dimension of ['width','height'])assert.ok(Number.isInteger(mask[dimension])&&mask[dimension]>=2&&mask[dimension]<=2048,`${context}: invalid mask ${dimension}`);
 assert.equal(maskSource?.scope,'russia-display-area');assert.deepEqual(maskSource.bounds,grid.bounds);
 assert.match(maskSource.coverageVersion,/^[a-f0-9]{16,64}$/);assert.ok(Array.isArray(maskSource.cells)&&maskSource.cells.length>0);
 assert.equal(maskSource.projection,'regular-longitude-latitude');assert.equal(maskSource.sampleLayout,'pixel-cells');
 assert.ok(Number.isInteger(maskSource.allowedPixels)&&maskSource.allowedPixels>0&&maskSource.allowedPixels<=mask.width*mask.height);
 assert.deepEqual(frame.displayMask,{width:mask.width,height:mask.height,allowedPixels:maskSource.allowedPixels,coverageVersion:maskSource.coverageVersion},`${context}: the prepared mask was not used by the rendered frame`);
 assert.ok(['yaw','pitch','zoom'].every(key=>Number.isFinite(frame.view?.[key])));assert.ok(frame.view.zoom>=.2&&frame.view.zoom<=1024);
 for(const key of['yaw','pitch','zoom'])assert.equal(frame.view[key],value.view[key],`${context}: camera angle/scale is not the rendered state`);
 const center=[(grid.bounds[0]+grid.bounds[2])/2,(grid.bounds[1]+grid.bounds[3])/2],radians=Math.PI/180,metres=6371008.8*radians;
 const widthM=(grid.bounds[2]-grid.bounds[0])*metres*Math.cos(center[1]*radians),heightM=(grid.bounds[3]-grid.bounds[1])*metres,scale=Math.max(widthM,heightM);
 assert.ok(Math.abs(value.view.longitude-(center[0]+frame.view.offset[0]/(widthM/scale)*(grid.bounds[2]-grid.bounds[0])))<1e-7,`${context}: rendered east offset does not match geographic camera`);
 assert.ok(Math.abs(value.view.latitude-(center[1]+frame.view.offset[1]/(heightM/scale)*(grid.bounds[3]-grid.bounds[1])))<1e-7,`${context}: rendered north offset does not match geographic camera`);
 assert.ok(Array.isArray(frame.view.offset)&&frame.view.offset.length===2&&frame.view.offset.every(Number.isFinite));
 if(value.cartography?.state==='ready'){
  const source=value.cartography.source;
  for(const key of['width','height'])assert.ok(Number.isInteger(value.cartography[key])&&value.cartography[key]>=2&&value.cartography[key]<=2048);
  assert.ok(['imagery','landcover'].includes(source.kind));assert.equal(source.complete,true,`${context}: a partial material window was committed`);
  assert.ok(typeof source.attribution==='string'&&source.attribution.length>0);assert.doesNotMatch(source.name||'',/openstreetmap|openfreemap|openmaptiles|opentopomap/i);
  assert.equal(source.rowOrder,'north-to-south');assert.equal(source.columnOrder,'west-to-east');
  if(source.kind==='landcover'){assert.match(source.name,/WorldCover/);assert.equal(source.nativeResolutionM,10);assert.equal(source.acquisitionPeriod,'2021');assert.equal(source.localTiles,1);assert.equal(source.requestedTiles,1);}
  else{assert.equal(value.cartography.width,1024);assert.equal(value.cartography.height,1024);assert.ok(['eox-s2','eox-bluemarble'].includes(source.provider));assert.ok(Array.isArray(source.tiles)&&source.tiles.length===source.requestedTiles);for(const tile of source.tiles)assert.match(tile.url,/^https:\/\/tiles\.maps\.eox\.at\//);}
  assert.deepEqual(source.bounds,grid.bounds);assert.equal(source.projection,'regular-longitude-latitude');assert.equal(source.sampleLayout,'grid-nodes');
  assert.ok(Number.isInteger(source.loadedTiles)&&source.loadedTiles>0&&source.loadedTiles<=16);assert.equal(source.requestedTiles,source.loadedTiles);assert.ok(source.requestedTiles<=16);
  assert.equal(frame.cartography?.loadedTiles,source.loadedTiles,`${context}: decoded cartography was never rendered`);
  assert.equal(frame.cartography.requestedTiles,source.requestedTiles);assert.equal(frame.cartography.width,value.cartography.width);assert.equal(frame.cartography.height,value.cartography.height);
 }
 return value;
}
