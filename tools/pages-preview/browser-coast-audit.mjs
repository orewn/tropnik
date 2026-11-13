import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {captureCoastLabels,assertCoastLabelInspection} from './browser-label-audit.mjs';
import {inspectCustomMapDOM,assertCustomMapInspection} from './browser-custom-map.mjs';
import {projectMapPoint} from './map-projection.mjs';
import {dispatchSourceEndPan,assertSourceEndPanInput} from './browser-source-end-pan.mjs';

const OUTPUT=new URL('../../web/pages-preview/design-qa/',import.meta.url);
export const COAST_REGION='territory-28173009B90810482533567';
// Actual vertices of the pinned, unsimplified display-source boundary.
export const COAST_FIXTURES=Object.freeze([
 {id:'primorsk',coordinate:[28.6069513,60.3623846],zooms:[7,9,12,15,18]},
 {id:'gogland',coordinate:[26.9596752,60.0633158],zooms:[11]},
]);

/** Small native touch translations can remain taps. Move away first, then
 * return in a second deliberate drag; their sum is the exact correction. */
export function coastPanPlan(dx,dy,rect,mobile){
 assert.ok([dx,dy,rect.width,rect.height].every(Number.isFinite)&&rect.width>0&&rect.height>0);
 const scale=Math.min(1,rect.width*.35/Math.max(1,Math.abs(dx)),rect.height*.3/Math.max(1,Math.abs(dy)));
 const delta={dx:dx*scale,dy:dy*scale},distance=Math.hypot(delta.dx,delta.dy);
 assert.ok(distance>3,'A coastline pan needs a measurable correction');
 const approach=Math.min(48,rect.width*.35/2,rect.height*.3/2);
 if(mobile&&distance<approach){
  assert.ok(approach>=24,'The exposed map is too small for a deliberate touch pan');
  const away={dx:-delta.dx/distance*approach,dy:-delta.dy/distance*approach};
  return[away,{dx:delta.dx-away.dx,dy:delta.dy-away.dy}];
 }
 return[delta];
}

/** Navigation reads the published camera and delegates only actual native
 * inputs. One zoom case shares twelve correction attempts across its steps. */
export function createCoastNavigation({read,drag,zoom,mobile,context}){
 async function panTo(coordinate,budget={attempts:0}){
  assert.ok(Number.isInteger(budget.attempts)&&budget.attempts>=0&&budget.attempts<=12);
  while(true){
   const map=await read(),point=projectMapPoint(coordinate,map.camera,map.rect);
   const center={x:map.rect.left+(map.camera.centerX??map.rect.width/2),y:map.rect.top+(map.camera.centerY??map.rect.height/2)};
   const dx=center.x-point.x,dy=center.y-point.y,distance=Math.hypot(dx,dy);
   if(distance<=6)return{map,centerErrorPx:distance};
   if(budget.attempts===12)throw new Error(`${context}: native panning did not center the source coastline`);
   const attempt=budget.attempts++;
   for(const [leg,planned] of coastPanPlan(dx,dy,map.rect,mobile).entries()){
    const before=await read();let delta=planned;
    if(leg>0){
     // Use the settled first drag, not its requested displacement: native
     // rounding or residual inertia must not become an assumed camera move.
     const actual=projectMapPoint(coordinate,before.camera,before.rect);
     const cx=before.rect.left+(before.camera.centerX??before.rect.width/2),cy=before.rect.top+(before.camera.centerY??before.rect.height/2);
     [delta]=coastPanPlan(cx-actual.x,cy-actual.y,before.rect,false);
     assert.ok(Math.hypot(delta.dx,delta.dy)>=24,`${context}: the native approach did not create a deliberate return drag`);
    }
    await drag(delta,{coordinate,attempt,leg,before});
   }
  }
 }
 async function reachZoom(target,coordinate){
  const budget={attempts:0};
  for(let attempt=0;attempt<28;attempt++){
   const map=await read(),currentZoom=map.camera.zoom;
   if(currentZoom>=target-.01&&currentZoom<target+1.01)return panTo(coordinate,budget);
   await zoom(currentZoom<target?'Увеличить масштаб':'Уменьшить масштаб');
   // Controls keep the visible-ground anchor fixed, which can differ from
   // the Canvas center. Correct each step before that offset is magnified;
   // every correction still spends this case's single twelve-attempt budget.
   await panTo(coordinate,budget);
  }
  throw new Error(`${context}: native coastline zoom did not reach ${target}`);
 }
 return{panTo,reachZoom};
}

/** Read only the selected route/region and public layer state. A native mouse
 * drag may end in a browser click, but it must not perform a map selection. */
export function inspectCoastPanSelection(doc=document,loc=location){
 const map=doc.querySelector('.atlas-canvas[data-map-engine]'),wrap=doc.querySelector('.atlas-wrap');
 if(!map||!wrap)return null;
 const params=new URLSearchParams(loc.search);
 return{pathname:loc.pathname,region:params.get('region')||'',route:params.get('route')||'',routeId:map.dataset.mapRouteId||'',drawnRoute:map.dataset.mapDrawnRoute||'',mode:wrap.dataset.mapBaseTarget||'',committedMode:wrap.dataset.mapBaseCommitted||''};
}

/** The own renderer publishes one coverage status in its bounded, read-only
 * frame inspection. Removed SDK dataset flags are not a second source of truth.
 * Keep the original receipt so acceptance can bind the summary to its actual
 * canvas, camera, bitmaps and geographic publication. Never coerce missing
 * pending/error values into a successful empty queue. */
export function inspectCoastCoverage(inspection){
 if(inspection?.engine!=='tropnik-canvas'||inspection.readOnly!==true||!inspection.coverage)return null;
 const {ready,pending,error,version,lod,cells,revision}=inspection.coverage;
 return{ready,pending,error,version,lod,cells:Array.isArray(cells)?[...cells]:null,revision,bitmapInspection:inspection};
}

export function assertCoastPanInput(pan,input,context){
 assertSourceEndPanInput(pan,input,context);
 const clicks=pan.events.filter(event=>event.type==='click');
 if(input==='touch')assert.equal(clicks.length,0,`${context}: a tap cannot count as a coastline pan`);
 else{
  assert.ok(clicks.length<=1,`${context}: a native drag emitted unexpected clicks`);
  const up=pan.events.find(event=>event.type==='pointerup');
  for(const click of clicks){
   assert.equal(click.trusted,true);assert.equal(click.pointerType,'mouse');assert.equal(click.pointerId,up.pointerId);
   assert.ok(pan.events.indexOf(click)>pan.events.indexOf(up),`${context}: a drag click preceded the delivered pointer release`);
   assert.ok(Number.isFinite(click.time)&&click.time>=up.time,`${context}: a drag click preceded pointer release`);
   assert.ok(Number.isFinite(click.x)&&Number.isFinite(click.y)&&Math.hypot(click.x-pan.end.x,click.y-pan.end.y)<=3,`${context}: a drag click belongs to another pointer target`);
   assert.match(click.target,/^CANVAS\[(?:[\w-]+\s+)*tropnik-map-canvas(?:\s+[\w-]+)*\]$/,`${context}: a drag clicked an interactive map control`);
   assert.equal(click.button,null,`${context}: a drag clicked a map marker`);
  }
 }
 assert.ok(pan.before?.camera&&pan.after?.camera&&pan.before?.rect&&pan.after?.rect,`${context}: native pan camera evidence is missing`);
 const before=pan.before,after=pan.after;
 for(const frame of [before,after]){
  assert.ok(frame.selection&&['pathname','region','route','routeId','drawnRoute'].every(key=>typeof frame.selection[key]==='string'),`${context}: native pan selection evidence is missing`);
  assert.ok(frame.selection.pathname.startsWith('/'),`${context}: native pan pathname evidence is invalid`);
  for(const key of ['mode','committedMode'])assert.ok(['overview','detail','satellite'].includes(frame.selection[key]),`${context}: native pan layer evidence is missing`);
 }
 assert.deepEqual(after.selection,before.selection,`${context}: native panning changed the pathname, route, region or layer selection`);
 for(const frame of [before,after])assert.ok(['longitude','latitude','zoom','tileSize'].every(key=>Number.isFinite(frame.camera[key])));
 assert.ok(Math.abs(before.camera.zoom-after.camera.zoom)<.001,`${context}: a pan must preserve the inspected zoom`);
 for(const key of ['left','top','width','height'])assert.equal(before.rect[key],after.rect[key],`${context}: map viewport changed during the pan`);
 const coordinate=[before.camera.longitude,before.camera.latitude];
 const first=projectMapPoint(coordinate,before.camera,before.rect),last=projectMapPoint(coordinate,after.camera,after.rect);
 assert.ok(Math.hypot(last.x-first.x,last.y-first.y)>3,`${context}: native pan did not move the actual camera`);
 return true;
}

export function assertCoastAudit(report,profile,engine){
 assert.equal(report?.schemaVersion,2,`${profile}: missing coastline regression evidence`);
 assert.equal(report.passed,true);assert.equal(report.profile,profile);assert.equal(report.engine,engine);
 assert.equal(report.visualReviewRequired,true);
 assert.equal(report.steps?.length,6);
 const versions=new Set();
 for(const fixture of COAST_FIXTURES)for(const targetZoom of fixture.zooms){
  const frame=report.steps.find(step=>step.fixture===fixture.id&&step.targetZoom===targetZoom);
  assert.ok(frame,`${profile}: missing ${fixture.id} at zoom ${targetZoom}`);
  assert.deepEqual(frame.coordinate,fixture.coordinate);
  assert.ok(frame.zoom>=targetZoom-.01&&frame.zoom<targetZoom+1.01);
  assert.ok(frame.centerErrorPx<=6,`${profile}: the coastline left the inspected viewport`);
  assert.equal(frame.ready,true);assert.equal(frame.pending,0);assert.equal(frame.error,'');
  const actual=assertCustomMapInspection(frame.bitmapInspection,`${profile}/coast/${fixture.id}/${targetZoom}`,{mode:'detail'});
  for(const key of ['ready','pending','error','version','lod','cells','revision'])assert.deepEqual(frame[key],actual.coverage[key],`${profile}: coastline ${key} differs from its rendered inspection`);
  assert.ok(Number.isInteger(frame.revision)&&frame.revision>=0,`${profile}: missing geographic revision`);
  assert.ok(Math.abs(actual.camera.center[0]-frame.camera.longitude)<1e-8&&Math.abs(actual.camera.center[1]-frame.camera.latitude)<1e-8&&Math.abs(actual.camera.zoom-frame.zoom)<1e-8&&Math.abs(actual.camera.zoom-frame.camera.zoom)<1e-8,`${profile}: coastline inspection has a stale camera`);
  assert.match(frame.version,/^[a-f0-9]{16}$/);versions.add(frame.version);
  assert.ok(['overview','regional','local','source'].includes(frame.lod));
  if(targetZoom===18)assert.equal(frame.lod,'source','Maximum zoom must use the source geometry');
  assert.ok(frame.cells.length>0&&frame.cells.length<=64);
  assert.equal(new Set(frame.cells).size,frame.cells.length);
  const shot=report.screenshots.find(image=>image.fixture===fixture.id&&image.targetZoom===targetZoom);
  assert.ok(shot?.bytes>1000);assert.match(shot.sha256,/^[a-f0-9]{64}$/);
  if(fixture.id==='primorsk')assertCoastLabelInspection(report.labelDiagnostics?.find(capture=>capture.fixture===fixture.id&&capture.targetZoom===targetZoom),frame,shot);
 }
 assert.equal(report.labelDiagnostics?.length,5,'Unexpected coastline label inspection count');
 assert.equal(versions.size,1,'A coastline audit mixed geometry publications');
 assert.ok(report.pans.length>=2,'Coastlines must be reached through native map gestures');
 for(const pan of report.pans)assertCoastPanInput(pan,profile!=='desktop-webgl'?'touch':'mouse',profile+'/coast');
 assert.ok(report.resources.some(resource=>resource.status===200&&resource.finished&&resource.path.endsWith('/data/map-coverage/manifest.json')),'No loaded geometry manifest');
 assert.ok(report.resources.some(resource=>resource.status===200&&resource.finished&&resource.path.includes('/data/map-coverage/cells/')),'No loaded coastal geometry cells');
 return report;
}

/** All navigation uses real inputs; only public DOM diagnostics are inspected.
 * This runs on CI Chromium, alongside the existing map acceptance matrix. */
export async function runCoastAudit(cdp,profile,helpers){
 const {loadProfile,evaluate,waitValue,sleep,settledMap,closeMapSheet,clearMapStories,pointerSelector}=helpers;
 const report={schemaVersion:2,profile:profile.name,engine:profile.engine,passed:false,visualReviewRequired:true,steps:[],pans:[],screenshots:[],resources:[],labelDiagnostics:[]};
 const resources=new Map();
 const unobserve=[
  cdp.observe('Network.responseReceived',({requestId,response})=>{
   if(!response?.url)return;const path=new URL(response.url).pathname;
   if(path.includes('/data/map-coverage/'))resources.set(requestId,{path,status:response.status,finished:false});
  }),
  cdp.observe('Network.loadingFinished',({requestId,encodedDataLength})=>{const item=resources.get(requestId);if(item)Object.assign(item,{finished:true,bytes:encodedDataLength});}),
  cdp.observe('Network.loadingFailed',({requestId,errorText})=>{const item=resources.get(requestId);if(item)item.error=errorText;}),
 ];
 const save=async()=>{report.resources=[...resources.values()];await mkdir(OUTPUT,{recursive:true});await writeFile(new URL(profile.name+'-coast.json',OUTPUT),JSON.stringify(report,null,2)+'\n');};
 const {panTo,reachZoom}=createCoastNavigation({
  mobile:profile.mobile,context:profile.name,read:()=>settledMap(cdp,profile.engine),
  zoom:label=>pointerSelector(cdp,`.map-controls button[aria-label="${label}"]`,profile),
  drag:async(delta,{coordinate,attempt,leg,before})=>{
   const beforeSelection=await evaluate(cdp,`(${inspectCoastPanSelection.toString()})()`);
   const start=await evaluate(cdp,`(()=>{
    const map=document.querySelector('.atlas-canvas[data-map-engine]'),r=map.getBoundingClientRect(),delta=${JSON.stringify(delta)};
    for(const fy of [.45,.6,.3,.75])for(const fx of [.5,.65,.35,.8,.2]){
     const point={x:r.left+r.width*fx,y:r.top+r.height*fy};let clear=true;
     for(let index=0;index<=12;index++){const x=point.x+delta.dx*index/12,y=point.y+delta.dy*index/12,hit=document.elementFromPoint(x,y);if(!hit||hit.tagName!=='CANVAS'||!map.contains(hit)){clear=false;break;}}
     if(clear)return point;
    }return null;
   })()`);
   assert.ok(start,`${profile.name}: no unobscured native pan path to the coastline`);
   await evaluate(cdp,'window.__tropnikInputEvents=[]');
   const pan=await dispatchSourceEndPan(cdp,start,delta,profile,sleep);
   const after=await settledMap(cdp,profile.engine);
   Object.assign(pan,{coordinate,attempt,leg,before:{camera:before.camera,rect:before.rect,selection:beforeSelection},after:{camera:after.camera,rect:after.rect,selection:await evaluate(cdp,`(${inspectCoastPanSelection.toString()})()`)}});
   pan.events=await evaluate(cdp,'window.__tropnikInputEvents');
   report.pans.push(pan);assertCoastPanInput(pan,profile.mobile?'touch':'mouse',profile.name+'/coast');
  }
 });
 try{
  for(const fixture of COAST_FIXTURES){
   const url=new URL(helpers.url);url.searchParams.set('region',COAST_REGION);
   await loadProfile(cdp,url.href,profile);await closeMapSheet(cdp,profile);await clearMapStories(cdp,profile);
   await panTo(fixture.coordinate);
   for(const targetZoom of fixture.zooms){
    const centered=await reachZoom(targetZoom,fixture.coordinate);
    const geometry=await waitValue(`${profile.name}: ${fixture.id} geometry did not settle at ${targetZoom}`,()=>evaluate(cdp,
     `(${inspectCoastCoverage.toString()})((${inspectCustomMapDOM.toString()})())`),state=>state?.ready===true&&state.pending===0&&state.error==='',20000);
    const frame={fixture:fixture.id,coordinate:fixture.coordinate,targetZoom,zoom:centered.map.camera.zoom,camera:centered.map.camera,centerErrorPx:centered.centerErrorPx,...geometry};
    report.steps.push(frame);
    const screenshot=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    const bytes=Buffer.from(screenshot.data,'base64'),file=`${profile.name}-coast-${fixture.id}-z${targetZoom}.png`;
    await mkdir(OUTPUT,{recursive:true});await writeFile(new URL(file,OUTPUT),bytes);
    const shot={fixture:fixture.id,targetZoom,file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    report.screenshots.push(shot);
    if(fixture.id==='primorsk')report.labelDiagnostics.push(await captureCoastLabels(cdp,evaluate,frame,shot));
    await save();
   }
  }
  report.resources=[...resources.values()];report.passed=true;
  assertCoastAudit(report,profile.name,profile.engine);await save();return report;
 }catch(error){report.passed=false;report.error=error.stack||String(error);await save();throw error;}
 finally{unobserve.forEach(dispose=>dispose());}
}
