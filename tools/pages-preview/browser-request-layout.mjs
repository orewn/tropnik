import assert from 'node:assert/strict';

/** Serialized into the existing page. Observers only read DOM geometry; they do
 * not resize the map, request a frame, warm a context or delay native actions. */
export function observeRequestMapLayout(){
 const container=document.querySelector('.atlas-canvas'),canvas=document.querySelector('.maplibregl-canvas');
 if(!container||!canvas)throw new Error('Request layout audit requires the existing WebGL map');
 const limit=32,samples=[],errors=[];let overflow=false,active=true,previous=null;
 const rect=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};
 const frame=()=>({time:performance.now(),viewport:{width:window.innerWidth,height:window.innerHeight,dpr:window.devicePixelRatio},rootClientWidth:document.documentElement.clientWidth,container:rect(container),canvas:rect(canvas),backing:{width:canvas.width,height:canvas.height},connected:container.isConnected&&canvas.isConnected&&document.querySelector('.atlas-canvas')===container&&document.querySelector('.maplibregl-canvas')===canvas});
 const record=(reason,mutations=[],force=false)=>{
  if(!active)return;
  try{
   const value=frame(),signature=JSON.stringify({...value,time:0});
   if(!force&&!mutations.length&&signature===previous)return;
   previous=signature;
   if(samples.length>=limit){overflow=true;return;}
   samples.push({...value,reason,mutations});
  }catch(error){if(errors.length<4)errors.push(String(error).slice(0,500));else overflow=true;}
 };
 const attributes=records=>{if(!active)return;if(records.length>limit)overflow=true;record('canvas-attributes',records.slice(0,limit).map(item=>({attribute:item.attributeName,oldValue:item.oldValue,currentValue:canvas.getAttribute(item.attributeName)})));};
 const resize=new ResizeObserver(()=>record('resize'));
 const mutation=new MutationObserver(attributes);
 try{
  resize.observe(container);resize.observe(canvas);
  mutation.observe(canvas,{attributes:true,attributeFilter:['width','height'],attributeOldValue:true});
  record('baseline',[],true);
 }catch(error){active=false;resize.disconnect();mutation.disconnect();throw error;}
 return{
  sample(){record('dialog-state');},
  stop(){
   if(active){
    try{const pending=mutation.takeRecords();if(pending.length)attributes(pending);record('final',[],true);}
    finally{active=false;resize.disconnect();mutation.disconnect();}
   }
   return{schemaVersion:1,scope:'desktop-request-dialog',limit,active,overflow,observers:{resize:true,canvasAttributes:true},errors,samples};
  },
 };
}

export function assertRequestMapLayout(receipt,context='request layout'){
 assert.equal(receipt?.schemaVersion,1,`${context}: missing measured layout receipt`);
 assert.equal(receipt.scope,'desktop-request-dialog');assert.equal(receipt.limit,32);
 assert.equal(receipt.active,false,`${context}: observers were not detached`);
 assert.equal(receipt.overflow,false,`${context}: layout observations exceeded the bound`);
 assert.deepEqual(receipt.observers,{resize:true,canvasAttributes:true});assert.deepEqual(receipt.errors,[]);
 assert.ok(Array.isArray(receipt.samples)&&receipt.samples.length>=2&&receipt.samples.length<=32);
 const baseline=receipt.samples[0];assert.equal(baseline.reason,'baseline');assert.equal(receipt.samples.at(-1).reason,'final');
 for(const [index,sample] of receipt.samples.entries()){
  assert.ok(Number.isFinite(sample.time)&&sample.time>=0);if(index)assert.ok(sample.time>=receipt.samples[index-1].time);
  assert.equal(sample.connected,true,`${context}: the observed map was replaced or detached`);
  assert.ok(['baseline','resize','canvas-attributes','dialog-state','final'].includes(sample.reason));
  assert.ok([sample.viewport?.width,sample.viewport?.height,sample.viewport?.dpr,sample.rootClientWidth].every(value=>Number.isFinite(value)&&value>0));
  assert.deepEqual(sample.viewport,baseline.viewport,`${context}: viewport changed during the fixed-viewport audit`);
  // root.clientWidth is diagnostic: CSSOM can include a reserved scrollbar
  // gutter differently while overflow is hidden. Actual map sizes are binding.
  for(const element of ['container','canvas'])for(const key of ['x','y','width','height']){
   assert.ok(Number.isFinite(sample[element]?.[key]));if(key==='width'||key==='height')assert.ok(sample[element][key]>0);
   assert.ok(Math.abs(sample[element][key]-baseline[element][key])<=.25,`${context}: ${element}.${key} changed during a request dialog`);
  }
  for(const key of ['width','height']){
   assert.ok(Number.isInteger(sample.backing?.[key])&&sample.backing[key]>0);
   assert.equal(sample.backing[key],baseline.backing[key],`${context}: canvas backing ${key} changed`);
  }
  assert.ok(Array.isArray(sample.mutations)&&sample.mutations.length<=32);
  for(const mutation of sample.mutations){
   assert.ok(['width','height'].includes(mutation.attribute));
   // oldValue catches an expand-and-restore coalesced into one observer callback.
   for(const value of [mutation.oldValue,mutation.currentValue])assert.equal(value,String(baseline.backing[mutation.attribute]),`${context}: transient canvas backing ${mutation.attribute} changed`);
  }
 }
 return receipt;
}
