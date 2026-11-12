import assert from 'node:assert/strict';

export const PRODUCT_MAP_MODES=Object.freeze([['Рельеф','detail'],['Спутник','satellite']]);

/** Read only the public canvas receipt and actual product controls. */
export function inspectProductMapModes(doc=document){
 const element=doc.querySelector('.atlas-canvas[data-map-engine="tropnik-canvas"]');
 let map;try{map=JSON.parse(element?.dataset.mapInspection||'null');}catch{return null;}
 if(!map)return null;
 return{engine:map.engine,camera:map.camera,pitch:map.pitch,routeId:map.routeId,drawnRoute:map.drawnRoute,drawRevision:map.drawRevision,state:map.state,
  tiles:{overview:map.tiles?.overview?.length||0,detail:map.tiles?.detail?.length||0,relief:map.tiles?.relief?.length||0,imagery:map.tiles?.imagery?.length||0},
  canvasCount:element.querySelectorAll('canvas.tropnik-map-canvas').length,terrainScenes:doc.querySelectorAll('.terrain-scene').length,
  controls:[...doc.querySelectorAll('.map-style-switch button')].map(button=>({label:button.getAttribute('aria-label'),pressed:button.getAttribute('aria-pressed'),disabled:button.disabled}))};
}

export function assertProductMapMode(frame,label,context,{routeId}={}){
 const mode=PRODUCT_MAP_MODES.find(value=>value[0]===label)?.[1];assert.ok(mode,`${context}: unknown product mode`);
 assert.equal(frame?.engine,'tropnik-canvas');assert.equal(frame.canvasCount,1,`${context}: the continuous map canvas is missing or duplicated`);
 assert.equal(frame.terrainScenes,0,`${context}: the removed 3D scene is still mounted`);assert.equal(frame.pitch,0,`${context}: a map mode tilted the camera`);
 assert.deepEqual(frame.controls?.map(control=>control.label),PRODUCT_MAP_MODES.map(value=>value[0]),`${context}: only Relief and Satellite belong in the mode switch`);
 for(const control of frame.controls){assert.equal(control.disabled,false);assert.equal(control.pressed,String(control.label===label),`${context}: mode selection is not exposed by aria-pressed`);}
 assert.equal(frame.state?.ready,true);assert.equal(frame.state.loading,false);assert.equal(frame.state.error,'');assert.equal(frame.state.mode,mode);
 assert.ok(Array.isArray(frame.camera?.center)&&frame.camera.center.length===2&&frame.camera.center.every(Number.isFinite));assert.ok(Number.isFinite(frame.camera.zoom));
 assert.ok(Number.isInteger(frame.drawRevision)&&frame.drawRevision>0);
 const committed=mode==='detail'&&frame.camera.zoom<5?'overview':mode;assert.equal(frame.state.committedMode,committed);
 if(mode==='satellite')assert.ok(frame.tiles.imagery>0,`${context}: selected Satellite has no rendered imagery`);
 else if(frame.camera.zoom>=5){assert.equal(frame.state.reliefReady,true,`${context}: Relief lost its height shading`);assert.ok(frame.tiles.detail>0&&frame.tiles.relief>0,`${context}: Relief has no actual detail and height tiles`);}
 else assert.ok(frame.tiles.overview>0,`${context}: the country relief ground is missing`);
 if(routeId!==undefined){assert.equal(frame.routeId,routeId);assert.equal(frame.drawnRoute,routeId,`${context}: mode switch lost the selected line`);}
 return frame;
}

export function assertProductMapModeTransition(transition,context,{routeId}={}){
 const beforeLabel=transition?.before?.state?.mode==='satellite'?'Спутник':'Рельеф';
 assertProductMapMode(transition?.before,beforeLabel,context+'/before',{routeId});assertProductMapMode(transition.after,transition.label,context+'/after',{routeId});
 assert.equal(transition.canvasRetained,true,`${context}: mode switch replaced the mounted map canvas`);
 for(let axis=0;axis<2;axis++)assert.ok(Math.abs(transition.after.camera.center[axis]-transition.before.camera.center[axis])<=1e-5,`${context}: mode switch moved the geographic focus`);
 assert.ok(Math.abs(transition.after.camera.zoom-transition.before.camera.zoom)<.01,`${context}: mode switch changed zoom`);
 assert.ok(Math.abs((transition.after.camera.bearingDegrees||0)-(transition.before.camera.bearingDegrees||0))<1e-7,`${context}: mode switch changed the compass direction`);
 assert.equal(transition.after.routeId,transition.before.routeId);assert.equal(transition.after.drawnRoute,transition.before.drawnRoute);
 assert.ok(transition.after.drawRevision>transition.before.drawRevision,`${context}: mode switch did not paint a new frame`);
 return transition;
}
