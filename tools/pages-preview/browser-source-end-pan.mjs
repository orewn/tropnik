import assert from 'node:assert/strict';

const finiteRect=r=>r&&['left','right','top','bottom','width','height'].every(key=>Number.isFinite(r[key]))&&r.width>0&&r.height>0;
const inside=(r,b)=>r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1;
const overlaps=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;
const moved=(r,dx,dy)=>({...r,left:r.left+dx,right:r.right+dx,top:r.top+dy,bottom:r.bottom+dy});
const parts=frame=>frame.markers?.flatMap(marker=>[marker.badge,marker.caption])||[];

/** Actual DOM footprints, including captions and the independently placed UI. */
export function sourceEndsAreFramed(frame){
 const annotations=parts(frame);
 return finiteRect(frame.available)&&annotations.length===4&&annotations.every(part=>part.visible&&finiteRect(part.rect)&&inside(part.rect,frame.available)&&!(frame.overlays||[]).some(overlay=>overlaps(part.rect,overlay.rect)));
}

/** Propose translations only. Source geometry and map camera are never written.
 * The caller still hit-tests every native drag path against the visible Canvas. */
export function sourceEndPanPlans(frame){
 if(sourceEndsAreFramed(frame))return[];
 const annotations=parts(frame);
 assert.ok(annotations.length===4&&annotations.every(part=>part.visible&&finiteRect(part.rect)),'Source-end framing requires four rendered full annotations');
 const area=frame.available;assert.ok(finiteRect(area));
 const bounds={left:Math.min(...annotations.map(part=>part.rect.left)),right:Math.max(...annotations.map(part=>part.rect.right)),top:Math.min(...annotations.map(part=>part.rect.top)),bottom:Math.max(...annotations.map(part=>part.rect.bottom))};
 bounds.width=bounds.right-bounds.left;bounds.height=bounds.bottom-bounds.top;
 assert.ok(bounds.width<=area.width&&bounds.height<=area.height,'Both source ends cannot fit at this fixed zoom');
 const padX=Math.min(12,(area.width-bounds.width)/2),padY=Math.min(12,(area.height-bounds.height)/2);
 const clamp=(value,low,high)=>Math.max(low,Math.min(high,value)),plans=[],seen=new Set();
 for(const fx of [.5,.65,.35,.75,.25])for(const fy of [.5,.6,.4,.7,.3]){
  const left=clamp(area.left+area.width*fx-bounds.width/2,area.left+padX,area.right-padX-bounds.width);
  const top=clamp(area.top+area.height*fy-bounds.height/2,area.top+padY,area.bottom-padY-bounds.height);
  const dx=left-bounds.left,dy=top-bounds.top,key=`${dx.toFixed(2)},${dy.toFixed(2)}`;
  if(seen.has(key))continue;seen.add(key);
  if(annotations.some(part=>(frame.overlays||[]).some(overlay=>overlaps(moved(part.rect,dx,dy),overlay.rect))))continue;
  // Both the down and final up must be inside the currently exposed map.
  const startArea={left:Math.max(area.left+12,area.left+12-dx),right:Math.min(area.right-12,area.right-12-dx),top:Math.max(area.top+12,area.top+12-dy),bottom:Math.min(area.bottom-12,area.bottom-12-dy)};
  if(startArea.right<=startArea.left||startArea.bottom<=startArea.top||Math.hypot(dx,dy)<=3)continue;
  const starts=[];
  for(const sy of [.5,.25,.75])for(const sx of [.5,.25,.75])starts.push({x:startArea.left+(startArea.right-startArea.left)*sx,y:startArea.top+(startArea.bottom-startArea.top)*sy});
  plans.push({dx,dy,starts,targetBounds:moved(bounds,dx,dy)});
 }
 assert.ok(plans.length,'No unobscured source-end placement fits a native drag at this zoom');
 return plans;
}

/** One native gesture, with every ACK recorded and a hold before release so the
 * resulting proof is a deliberate pan rather than a velocity-dependent fling. */
export async function dispatchSourceEndPan(cdp,start,delta,profile,sleep){
 const end={x:start.x+delta.dx,y:start.y+delta.dy};
 assert.ok([start.x,start.y,end.x,end.y].every(Number.isFinite));assert.ok(Math.hypot(delta.dx,delta.dy)>3);
 const input=profile.mobile?'touch':'mouse',commands=[],began=performance.now(),id=91;
 const send=async(type,point)=>{
  const method=profile.mobile?'Input.dispatchTouchEvent':'Input.dispatchMouseEvent';
  const command={method,type,x:point?.x??end.x,y:point?.y??end.y,sentOffsetMs:performance.now()-began};commands.push(command);
  const params=profile.mobile?{type,touchPoints:type==='touchEnd'?[]:[{...point,id,radiusX:3,radiusY:3,force:1}]}:
   {type,...point,pointerType:'mouse',...(type==='mouseMoved'&&commands.length===1?{}:{button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1})};
  try{await cdp.call(method,params);command.status='fulfilled';}
  catch(error){command.status='rejected';command.error=error?.message||String(error);throw error;}
  finally{command.ackOffsetMs=performance.now()-began;}
 };
 let failure;
 if(!profile.mobile)await send('mouseMoved',start);
 try{
  await send(profile.mobile?'touchStart':'mousePressed',start);
  for(let index=1;index<=12;index++){
   await send(profile.mobile?'touchMove':'mouseMoved',{x:start.x+delta.dx*index/12,y:start.y+delta.dy*index/12});await sleep(25);
  }
  await sleep(200);
 }catch(error){failure=error;}
 finally{
  try{await send(profile.mobile?'touchEnd':'mouseReleased',end);}catch(error){failure??=error;}
 }
 const receipt={input,start,end,delta:{dx:delta.dx,dy:delta.dy},holdBeforeReleaseMs:200,commands,durationMs:performance.now()-began};
 if(failure){failure.panDiagnostics=receipt;throw failure;}
 return receipt;
}

export function assertSourceEndPanInput(pan,input,context){
 assert.equal(pan.input,input);assert.ok(pan.start&&pan.end&&pan.delta);
 assert.ok([pan.start.x,pan.start.y,pan.end.x,pan.end.y,pan.delta.dx,pan.delta.dy].every(Number.isFinite));
 assert.ok(Math.abs(pan.end.x-pan.start.x-pan.delta.dx)<.01&&Math.abs(pan.end.y-pan.start.y-pan.delta.dy)<.01);
 assert.ok(Math.hypot(pan.delta.dx,pan.delta.dy)>3);assert.equal(pan.holdBeforeReleaseMs,200);
 const mobile=input==='touch',types=mobile?['touchStart',...Array(12).fill('touchMove'),'touchEnd']:['mouseMoved','mousePressed',...Array(12).fill('mouseMoved'),'mouseReleased'];
 assert.deepEqual(pan.commands?.map(command=>command.type),types,`${context}: native pan command sequence is missing`);
 let previous=0;
 for(const [index,command] of pan.commands.entries()){
  assert.equal(command.method,mobile?'Input.dispatchTouchEvent':'Input.dispatchMouseEvent');assert.equal(command.status,'fulfilled');
  assert.ok([command.x,command.y,command.sentOffsetMs,command.ackOffsetMs].every(Number.isFinite));
  assert.ok(command.sentOffsetMs>=previous&&command.ackOffsetMs>=command.sentOffsetMs);previous=command.ackOffsetMs;
  const progress=Math.max(0,Math.min(1,(index-(mobile?0:1))/12));
  assert.ok(Math.hypot(command.x-pan.start.x-pan.delta.dx*progress,command.y-pan.start.y-pan.delta.dy*progress)<.01,`${context}: the native drag path differs from its recorded translation`);
 }
 assert.ok(pan.commands.at(-1).sentOffsetMs-pan.commands.at(-2).ackOffsetMs>=190,`${context}: native pan released before its stationary hold`);
 assert.ok(Number.isFinite(pan.durationMs)&&pan.durationMs>=previous);
 const events=pan.events?.filter(event=>event.type==='pointerdown'||event.type==='pointerup');
 assert.equal(events?.length,2,`${context}: native pan needs one delivered down/up pair`);
 assert.equal(events[0].type,'pointerdown');assert.equal(events[1].type,'pointerup');
 assert.equal(events[0].pointerId,events[1].pointerId);assert.ok(Number.isInteger(events[0].pointerId));
 assert.ok(Number.isFinite(events[0].time)&&events[1].time>=events[0].time);
 for(const [index,event] of events.entries()){
  assert.equal(event.trusted,true);assert.equal(event.pointerType,input);const point=index?pan.end:pan.start;
  assert.ok(Number.isFinite(event.x)&&Number.isFinite(event.y)&&Math.hypot(event.x-point.x,event.y-point.y)<=3,`${context}: the delivered pointer differs from the requested drag`);
 }
 return true;
}
