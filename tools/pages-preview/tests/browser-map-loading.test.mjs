import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_LOADING_PROFILE,MAP_LOADING_ROUTE,MAP_LOADING_LIMITS,MAP_LOADING_PIXEL_LIMITS,planLoadingZoom,mapLoadingResource,
  holdMapLoadingHalo,rectangleUnionArea,loadingCoverage,assertMapLoadingProgress,observeMapLoadingNetwork,
  loadingPixelROIs,compareMapLoadingPixels,
} from '../browser-map-loading.mjs';

function transport(fail){
  const listeners=new Map(),calls=[];
  return{calls,listeners,
    emit(name,event){for(const callback of listeners.get(name)||[])callback(event);},
    observe(name,callback){const set=listeners.get(name)||new Set();set.add(callback);listeners.set(name,set);return()=>{set.delete(callback);if(!set.size)listeners.delete(name);};},
    async call(method,params={}){calls.push({method,params});if(fail?.(method,params))throw new Error('Deliberate transport failure');return{};},
  };
}
const project=([longitude,latitude])=>({x:(longitude+180)/360,y:(1-Math.asinh(Math.tan(latitude*Math.PI/180))/Math.PI)/2});
const unproject=({x,y})=>[x*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y)))*180/Math.PI];
const cellKey=tile=>[tile.z,tile.x,tile.y].join('/');
function tile(cell,kind){
  const n=2**cell.z,sw=unproject({x:cell.x/n,y:(cell.y+1)/n}),ne=unproject({x:(cell.x+1)/n,y:cell.y/n});
  return{...cell,kind,key:kind+':'+cellKey(cell)+':1:0:'+cell.z+':1',local:false,width:512,height:512,transparent:false,bounds:[sw[0],sw[1],ne[0],ne[1]]};
}
function coveringCells(map,z){
  const n=2**z,center=project(map.camera.center),scale=256*2**map.camera.zoom,cells=[];
  for(let y=Math.floor((center.y-map.viewport.height/(2*scale))*n);y<=Math.floor((center.y+map.viewport.height/(2*scale))*n);y++)
    for(let x=Math.floor((center.x-map.viewport.width/(2*scale))*n);x<=Math.floor((center.x+map.viewport.width/(2*scale))*n);x++)cells.push({z,x,y});
  return cells;
}
function fixture(){
  const map={engine:'tropnik-canvas',readOnly:true,pitch:0,camera:{center:[56.4372266,57.9741523],zoom:11.5,bearingDegrees:0},
    viewport:{width:1055,height:932,padding:{left:24,right:80,top:88,bottom:180}},
    state:{ready:true,loading:false,error:'',mode:'detail',committedMode:'detail'},coverage:{ready:true,pending:0,error:'',revision:2},
    catalogueOverlay:{currentViewportReady:true,pending:false,error:''},
    routeId:MAP_LOADING_ROUTE.id,drawnRoute:MAP_LOADING_ROUTE.id,drawRevision:10,labels:[],loadingGround:null,
    canvas:{connected:true,width:1055,height:932,cssWidth:1055,cssHeight:932},tiles:{overview:[],detail:[],relief:[],imagery:[]}};
  const oldCells=coveringCells(map,12);map.tiles.detail=oldCells.map(cell=>tile(cell,'vector'));map.tiles.relief=oldCells.map(cell=>tile(cell,'relief'));
  map.tiles.overview=coveringCells(map,4).map(cell=>tile(cell,'overview'));
  const before={map,rect:{left:385,top:68,right:1440,bottom:1000,width:1055,height:932},viewport:{width:1440,height:1000,dpr:1},moving:false,
    selection:{route:MAP_LOADING_ROUTE.id,region:MAP_LOADING_ROUTE.regionId,title:MAP_LOADING_ROUTE.title}};
  const plan=planLoadingZoom(before),pending=structuredClone(before);
  pending.map.camera=plan.camera;pending.map.state.loading=true;pending.map.drawRevision++;
  const ready=plan.cells.slice(0,-1);
  pending.map.loadingGround={generation:4,requestedCells:plan.cells.length,readyCells:ready.length,detail:ready.map(cell=>tile(cell,'vector')),relief:ready.map(cell=>tile(cell,'relief'))};
  const halo=plan.haloCandidates[0],url='https://tiles.mapterhorn.com/'+cellKey(halo)+'.webp';
  const held={schemaVersion:1,kind:'one-real-external-dem-halo',timeoutMs:MAP_LOADING_LIMITS.holdMs,acquireTimeoutMs:MAP_LOADING_LIMITS.acquireMs,pending:1,closed:false,reason:null,errors:[],held:{networkId:'real-network',url,cell:halo,resumedAtEpochMs:null}};
  const network={overflow:0,records:[{requestId:'real-network',url,finishedAtEpochMs:null,failed:null},
    {requestId:'vector-complete',url:'https://tiles.openfreemap.org/planet/pinned/'+cellKey(plan.cells[0])+'.pbf',kind:'vector',finishedAtEpochMs:1,status:200,failed:null},
    {requestId:'dem-complete',url:'https://tiles.mapterhorn.com/'+cellKey(plan.cells[0])+'.webp',kind:'dem',finishedAtEpochMs:1,status:200,failed:null}]};
  return{before,pending,plan,held,network};
}

test('the route zoom plan preserves the native asymmetric anchor and separates all external halo cells',()=>{
  const {before,plan}=fixture();
  assert.equal(plan.level,11);assert.ok(plan.cells.length>4&&plan.cells.length<=64);
  const p=before.map.viewport.padding,anchor={x:(p.left-p.right)/2,y:(p.top-p.bottom)/2};
  const old=project(before.map.camera.center),next=project(plan.camera.center),oldScale=256*2**before.map.camera.zoom,nextScale=256*2**plan.camera.zoom;
  assert.ok(Math.abs(old.x+anchor.x/oldScale-next.x-anchor.x/nextScale)<1e-14);
  assert.ok(Math.abs(old.y+anchor.y/oldScale-next.y-anchor.y/nextScale)<1e-14);
  assert.notDeepEqual(plan.camera.center,before.map.camera.center,'The asymmetric anchor must change the camera center');
  const requested=new Set(plan.cells.map(cellKey));
  assert.ok(plan.haloCandidates.length>0);assert.ok(plan.haloCandidates.every(cell=>!requested.has(cellKey(cell))));
  for(const halo of plan.haloCandidates)assert.ok(plan.cells.some(cell=>Math.abs(halo.x-cell.x)<=1&&Math.abs(halo.y-cell.y)<=1));
  const wrong=structuredClone(before);wrong.map.camera.bearingDegrees=10;assert.throws(()=>planLoadingZoom(wrong));
  wrong.map.camera.bearingDegrees=0;wrong.map.camera.zoom=10.5;assert.throws(()=>planLoadingZoom(wrong),/z11/);
});

test('only canonical public DEM/vector source URLs enter the delayed-source proof',()=>{
  assert.deepEqual(mapLoadingResource('https://tiles.mapterhorn.com/11/1341/617.webp'),{kind:'dem',z:11,x:1341,y:617,url:'https://tiles.mapterhorn.com/11/1341/617.webp'});
  assert.equal(mapLoadingResource('https://tiles.openfreemap.org/planet/20261101_001001_pt/11/1341/617.pbf')?.kind,'vector');
  for(const url of ['http://tiles.mapterhorn.com/11/1341/617.webp','https://user:secret@tiles.mapterhorn.com/11/1341/617.webp',
    'https://tiles.mapterhorn.com/11/1341/617.webp?token=secret','https://tiles.mapterhorn.com/11/2048/617.webp',
    'https://tiles.mapterhorn.com:444/11/1341/617.webp','https://other.invalid/11/1341/617.webp'])assert.equal(mapLoadingResource(url),null);
});

test('a single real halo is held while a primary, another halo and every response byte remain untouched',async()=>{
  const {plan}=fixture(),cdp=transport(),gate=await holdMapLoadingHalo(cdp,plan);
  const primary='https://tiles.mapterhorn.com/'+cellKey(plan.cells[0])+'.webp';
  const url='https://tiles.mapterhorn.com/'+cellKey(plan.haloCandidates[0])+'.webp';
  const another='https://tiles.mapterhorn.com/'+cellKey(plan.haloCandidates[1])+'.webp';
  cdp.emit('Fetch.requestPaused',{requestId:'primary',networkId:'p',request:{url:primary}});
  cdp.emit('Fetch.requestPaused',{requestId:'held',networkId:'h',request:{url}});
  cdp.emit('Fetch.requestPaused',{requestId:'other-halo',networkId:'a',request:{url:another}});
  const pending=gate.snapshot();assert.equal(pending.pending,1);assert.equal(pending.held.networkId,'h');assert.equal(pending.held.url,url);
  assert.deepEqual(cdp.calls.filter(call=>call.method==='Fetch.continueRequest').map(call=>call.params.requestId),['primary','other-halo']);
  const complete=await gate.release('progress-captured');assert.equal(complete.pending,0);assert.equal(complete.reason,'progress-captured');assert.deepEqual(complete.errors,[]);
  assert.equal(pending.held.resumedAtEpochMs,null,'The pending receipt must remain immutable after release');
  assert.ok(complete.held.resumedAtEpochMs>=complete.held.pausedAtEpochMs);assert.equal(cdp.listeners.size,0);
  await gate.release('finally');assert.equal(cdp.calls.filter(call=>call.method==='Fetch.disable').length,1);
  assert.ok(cdp.calls.every(call=>['Fetch.enable','Fetch.continueRequest','Fetch.disable'].includes(call.method)));
  for(const call of cdp.calls.filter(call=>call.method==='Fetch.continueRequest'))assert.deepEqual(Object.keys(call.params),['requestId']);
});

test('failed resume and the real bounded timeout still remove interception and preserve the failure',async()=>{
  const {plan}=fixture(),url='https://tiles.mapterhorn.com/'+cellKey(plan.haloCandidates[0])+'.webp';
  const broken=transport(method=>method==='Fetch.continueRequest'),first=await holdMapLoadingHalo(broken,plan);
  broken.emit('Fetch.requestPaused',{requestId:'held',networkId:'n',request:{url}});
  const failed=await first.release('finally');assert.equal(failed.pending,0);assert.ok(failed.errors.some(value=>value.includes('Deliberate')));assert.equal(broken.listeners.size,0);
  assert.equal(broken.calls.at(-1).method,'Fetch.disable');
  const cdp=transport(),timed=await holdMapLoadingHalo(cdp,plan,{timeoutMs:20});
  cdp.emit('Fetch.requestPaused',{requestId:'held',networkId:'n',request:{url}});
  await new Promise(resolve=>setTimeout(resolve,40));
  const result=await timed.release('finally');assert.equal(result.reason,'timeout');assert.equal(result.pending,0);assert.equal(cdp.listeners.size,0);
  assert.ok(result.errors.some(value=>value.includes('bounded deadline')));
  await assert.rejects(()=>holdMapLoadingHalo(transport(),plan,{timeoutMs:MAP_LOADING_LIMITS.holdMs+1}));
});

test('acquisition time does not spend the actual pause and a missing halo remains a setup failure',async()=>{
  const {plan}=fixture(),cdp=transport(),gate=await holdMapLoadingHalo(cdp,plan,{timeoutMs:20,acquireTimeoutMs:200});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(gate.snapshot().closed,false);assert.equal(gate.snapshot().held,null,'The twenty-ms pause has not started before a real request');
  cdp.emit('Fetch.requestPaused',{requestId:'held',networkId:'n',request:{url:'https://tiles.mapterhorn.com/'+cellKey(plan.haloCandidates[0])+'.webp'}});
  const acquired=gate.snapshot();assert.ok(acquired.held.pausedAtMonotonicMs-acquired.enabledAtMonotonicMs>=30);assert.equal(acquired.closed,false);
  await new Promise(resolve=>setTimeout(resolve,35));
  const released=await gate.release('finally');assert.equal(released.reason,'timeout');assert.ok(released.held.resumedAtMonotonicMs>=released.held.pausedAtMonotonicMs);
  const empty=await holdMapLoadingHalo(transport(),plan,{timeoutMs:20,acquireTimeoutMs:20});
  await new Promise(resolve=>setTimeout(resolve,35));
  const missing=await empty.release('finally');assert.equal(missing.reason,'acquire-timeout');assert.equal(missing.held,null);assert.equal(missing.pending,0);
});

test('coverage computes the exact union, including overlaps, narrow holes and expansion outside old ground',()=>{
  const rect=(left,top,right,bottom)=>({left,top,right,bottom});
  assert.equal(rectangleUnionArea([rect(0,0,10,10),rect(5,0,15,10)]),150);
  assert.equal(rectangleUnionArea([rect(0,0,5,10),rect(5.01,0,10,10)]),99.9);
  assert.equal(rectangleUnionArea([rect(3,3,2,2)]),0);
  const {pending}=fixture(),coverage=loadingCoverage(pending);
  assert.ok(coverage.expandedCssPixels>1000);assert.equal(coverage.coveredCssPixels,coverage.visibleCssPixels);
});

test('progress rejects the old all-pairs barrier, stale/unpaired metadata, primary holds, bypasses and coverage holes',()=>{
  const good=fixture();assert.ok(assertMapLoadingProgress(good.before,good.pending,good.plan,good.held,good.network).expandedCssPixels>0);
  const check=(mutate,pattern)=>{const value=structuredClone(good);mutate(value);assert.throws(()=>assertMapLoadingProgress(value.before,value.pending,value.plan,value.held,value.network),pattern);};
  check(value=>{value.pending.map.loadingGround=null;},/No independently painted loading ground/);
  check(value=>{value.pending.map.loadingGround.relief.pop();});
  check(value=>{
    const cell={...value.plan.cells[0],x:value.plan.cells[0].x+20};
    value.pending.map.loadingGround.detail[0]=tile(cell,'vector');value.pending.map.loadingGround.relief[0]=tile(cell,'relief');
  },/stale/);
  check(value=>{value.pending.map.tiles.detail=value.pending.map.loadingGround.detail;},/canonical detail/);
  check(value=>{value.held.held.cell=value.plan.cells[0];});
  check(value=>{value.held.closed=true;});
  check(value=>{value.network.records[0].finishedAtEpochMs=1;});
  check(value=>{value.network.records.push({...value.network.records[0],requestId:'bypass'});},/duplicate physical fetch/);
  check(value=>{
    value.pending.map.tiles.overview=[];value.pending.map.tiles.detail=[];value.before.map.tiles.detail=[];
    const chosen=value.plan.cells.slice(Math.floor(value.plan.cells.length/2),Math.floor(value.plan.cells.length/2)+2);
    Object.assign(value.pending.map.loadingGround,{readyCells:2,detail:chosen.map(cell=>tile(cell,'vector')),relief:chosen.map(cell=>tile(cell,'relief'))});
  },/hole/);
});

test('the independent network ledger bounds memory, retains the held identity and does not alter transport',()=>{
  const {plan}=fixture(),cdp=transport(),observer=observeMapLoadingNetwork(cdp,plan),url='https://tiles.mapterhorn.com/'+cellKey(plan.haloCandidates[0])+'.webp';
  cdp.emit('Network.requestWillBeSent',{requestId:'held',request:{url},timestamp:10});
  const pending=observer.snapshot();assert.equal(pending.records[0].finishedAtEpochMs,null);
  cdp.emit('Network.responseReceived',{requestId:'held',response:{status:200,fromServiceWorker:false,fromDiskCache:false}});
  cdp.emit('Network.loadingFinished',{requestId:'held',timestamp:12,encodedDataLength:1234});
  const complete=observer.snapshot();assert.equal(complete.records[0].status,200);assert.equal(complete.records[0].encodedBytes,1234);
  assert.equal(pending.records[0].status,null,'Earlier observations must not acquire later completion data');
  for(let index=0;index<MAP_LOADING_LIMITS.networkRecords;index++)cdp.emit('Network.requestWillBeSent',{requestId:'extra-'+index,request:{url},timestamp:13});
  assert.equal(observer.snapshot().records.length,MAP_LOADING_LIMITS.networkRecords);assert.equal(observer.snapshot().overflow,1);
  observer.dispose();assert.equal(cdp.listeners.size,0);assert.deepEqual(cdp.calls,[]);
});

function pixelFixture(){
  const {pending,plan}=fixture(),complete=structuredClone(pending);complete.map.loadingGround=null;complete.map.state.loading=false;complete.map.drawRevision++;
  complete.map.tiles.detail=plan.cells.map(cell=>tile(cell,'vector'));complete.map.tiles.relief=plan.cells.map(cell=>tile(cell,'relief'));
  const rois=loadingPixelROIs(pending);
  // Unit-only arrays exercise the comparator's negative controls. Runtime
  // samples exclusively use getImageData on the unmodified production Canvas.
  const textured=new Uint8Array(MAP_LOADING_PIXEL_LIMITS.size**2*4),flat=new Uint8Array(textured.length);
  for(let offset=0;offset<textured.length;offset+=4){
    const index=offset/4,x=index%64,y=Math.floor(index/64);
    textured.set([40+(x*7+y*11)%96,80+(x*13+y*3)%96,25+(x+y)%32,255],offset);flat.set([220,229,207,255],offset);
  }
  const capture=frame=>rois.map(roi=>({roi,unobscured:true,rgbaBase64:Buffer.from(textured).toString('base64'),camera:frame.map.camera,drawRevision:frame.map.drawRevision,generation:frame.map.loadingGround?.generation??null}));
  return{pending,complete,rois,early:capture(pending),final:capture(complete),textured,flat};
}

test('pixel ROIs are fixed before reference pixels, inset from cells, outside old ground and away from controls',()=>{
  const {pending,rois}=pixelFixture();
  assert.ok(rois.length>0&&rois.length<=24);assert.ok(new Set(rois.map(roi=>cellKey(roi.cell))).size>=2);
  const visible=loadingCoverage(pending).visible;
  for(const roi of rois){assert.equal(roi.width,64);assert.equal(roi.height,64);assert.ok(roi.x>=visible.left&&roi.y>=visible.top&&roi.x+64<=visible.right&&roi.y+64<=visible.bottom);}
  const first=rois[0],changed=structuredClone(pending);changed.occlusions=[{left:first.x,top:first.y,right:first.x+64,bottom:first.y+64}];
  for(const roi of loadingPixelROIs(changed))assert.ok(roi.x+64<=first.x||roi.x>=first.x+64||roi.y+64<=first.y||roi.y>=first.y+64);
  changed.occlusions=[visible];assert.deepEqual(loadingPixelROIs(changed),[]);
});

test('every textured reference ROI must exactly match; metadata-only, flat and stale loading paint fail',()=>{
  const value=pixelFixture(),compare=(early=value.early,final=value.final)=>compareMapLoadingPixels(value.pending,value.complete,early,final);
  const good=compare();assert.ok(good.eligibleCells.length>=2);assert.equal(good.differentEligiblePixels,0);
  assert.ok(good.comparisons.every(item=>item.eligible&&item.differentPixels===0));
  const flat=value.early.map(sample=>({...sample,rgbaBase64:Buffer.from(value.flat).toString('base64')}));
  assert.throws(()=>compare(flat),error=>error.code==='MAP_LOADING_PIXELS_DIFFER','Ready metadata plus retained flat paint must not pass');
  const bothFlat=value.final.map(sample=>({...sample,rgbaBase64:Buffer.from(value.flat).toString('base64')}));
  assert.throws(()=>compare(flat,bothFlat),error=>error.code==='MAP_LOADING_NO_TEXTURED_REFERENCE','Matching flat images cannot certify new map detail');
  const stale=structuredClone(value.early),bytes=Buffer.from(stale[0].rgbaBase64,'base64');bytes[0]^=1;stale[0].rgbaBase64=bytes.toString('base64');
  assert.throws(()=>compare(stale),error=>error.code==='MAP_LOADING_PIXELS_DIFFER','One wrong eligible ROI must fail even when many others match');
  const hidden=value.final.map(sample=>({...sample,unobscured:cellKey(sample.roi.cell)===cellKey(value.rois[0].cell)}));
  assert.throws(()=>compare(value.early,hidden),error=>error.code==='MAP_LOADING_NO_TEXTURED_REFERENCE','One cell cannot stand in for independent spatial progress');
  const moved=structuredClone(value.complete);moved.map.camera.zoom+=.1;
  assert.throws(()=>compareMapLoadingPixels(value.pending,moved,value.early,value.final),'A different camera is not a pixel reference');
});

test('reference eligibility uses final texture and geometry, never selection of matching pixels',()=>{
  const value=pixelFixture(),early=structuredClone(value.early),final=structuredClone(value.final);
  early[0].rgbaBase64=Buffer.from(value.flat).toString('base64');final[0].rgbaBase64=Buffer.from(value.flat).toString('base64');
  const result=compareMapLoadingPixels(value.pending,value.complete,early,final);
  assert.equal(result.comparisons[0].eligible,false);assert.equal(result.comparisons[0].texturedReference,false);assert.ok(result.eligibleCells.length>=2);
  const corrupt=Buffer.from(early[1].rgbaBase64,'base64');corrupt[30]^=1;early[1].rgbaBase64=corrupt.toString('base64');
  assert.throws(()=>compareMapLoadingPixels(value.pending,value.complete,early,final),error=>error.code==='MAP_LOADING_PIXELS_DIFFER');
});
