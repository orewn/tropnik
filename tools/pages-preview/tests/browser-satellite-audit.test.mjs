import test from 'node:test';
import assert from 'node:assert/strict';
import {satelliteResource,observeSatelliteResources,successfulSatelliteResources,satelliteResourcesAt,satelliteRequestStateAt,satelliteTileContains,assertSatelliteContinuityAudit,assertSatelliteCameraUnchanged,assertSatellitePreload,satellitePerformanceIssues} from '../browser-satellite-audit.mjs';
import {projectMapPoint} from '../map-projection.mjs';
import {coastPanPlan} from '../browser-coast-audit.mjs';
import {satelliteFixture} from './satellite-fixture.mjs';

const nasa='https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/4/3/0.jpg';
const eox='https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/4/3/14.jpg';

test('imagery evidence accepts only the exact public layers, bounded native zooms and valid tile coordinates',()=>{
 assert.deepEqual(satelliteResource(nasa),{url:nasa,source:'eox-bluemarble',tile:{z:4,x:0,y:3}});
 assert.deepEqual(satelliteResource(eox).tile,{z:4,x:14,y:3});
 for(const url of [nasa.replace('/4/3/0','/9/3/0'),nasa.replace('/4/3/0','/4/3/16'),nasa.replace('bluemarble_3857','Other'),nasa.replace('https:','http:'),nasa+'?forged=1',nasa.replace('eox.at','eox.at.example'),eox.replace('s2cloudless_3857','s2cloudless-2024_3857'),'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/4/3/0.jpeg','invalid'])assert.equal(satelliteResource(url),null,url);
 assert.equal(satelliteTileContains({z:4,x:0,y:3},[180,67.5]),true);
 assert.equal(satelliteTileContains({z:4,x:0,y:3},[-180,67.5]),true);
 assert.equal(satelliteTileContains({z:4,x:0,y:3},[540,67.5]),true);
 assert.equal(satelliteTileContains({z:4,x:14,y:3},[140,67.5]),true);
 assert.equal(satelliteTileContains({z:4,x:14,y:3},[180,67.5]),false);
});

test('completed image responses are independent of ready state and preserve failures, cache hits and bounded observation',()=>{
 const listeners=new Map(),cdp={observe(name,callback){listeners.set(name,callback);return()=>listeners.delete(name);}},emit=(name,value)=>listeners.get(name)?.(value);
 const observer=observeSatelliteResources(cdp,()=> 'dateline-close');
 emit('Network.requestWillBeSent',{requestId:'nasa',request:{url:nasa},timestamp:1});
 emit('Network.responseReceived',{requestId:'nasa',response:{url:nasa,status:200,mimeType:'image/jpeg',fromDiskCache:true},timestamp:2});
 assert.equal(successfulSatelliteResources(observer.snapshot(),'eox-bluemarble').length,0,'HTTP success without transfer completion is insufficient');
 emit('Network.loadingFinished',{requestId:'nasa',encodedDataLength:0,timestamp:3});
 assert.equal(successfulSatelliteResources(observer.snapshot(),'eox-bluemarble').length,1,'A finished cached image remains valid evidence');
 const saved=observer.snapshot();assert.equal(saved.requests[0].phase,'dateline-close');assert.equal(saved.requests[0].fromDiskCache,true);
 emit('Network.requestWillBeSent',{requestId:'failed',request:{url:eox},timestamp:4});
 emit('Network.responseReceived',{requestId:'failed',response:{url:eox,status:404,mimeType:'image/jpeg'},timestamp:5});
 emit('Network.loadingFinished',{requestId:'failed',encodedDataLength:100,timestamp:6});
 emit('Network.requestWillBeSent',{requestId:'broken',request:{url:nasa},timestamp:7});
 emit('Network.loadingFailed',{requestId:'broken',errorText:'net::ERR_FAILED',timestamp:8});
 assert.equal(successfulSatelliteResources(observer.snapshot(),'eox-s2').length,0);assert.equal(observer.snapshot().requests[2].error,'net::ERR_FAILED');
 assert.equal(saved.requests.length,1,'Later events cannot mutate captured proof');
 for(let index=0;index<512;index++)emit('Network.requestWillBeSent',{requestId:'new-'+index,request:{url:nasa},timestamp:9});
 assert.equal(observer.snapshot().requests.length,512);assert.equal(observer.snapshot().discardedRequests,3);
 observer.dispose();assert.equal(listeners.size,0);
});

for(const profile of ['android-portrait','desktop-webgl'])test(`${profile} custom-map continuity requires native gestures, provider transfers, lower-detail credit and camera-preserving toggles`,()=>{
 const engine='tropnik-canvas',fixture=satelliteFixture(profile,engine);
 assert.equal(assertSatelliteContinuityAudit(fixture,profile,engine),fixture);
 const changes=[
  value=>delete value.steps,
  value=>value.steps[0].state='loading',
  value=>value.steps[0].source='eox-s2',
  value=>value.steps[0].resolution='detail',
  value=>value.steps[0].credit.text='NASA Blue Marble',
  value=>value.steps[0].credit.visible=false,
  value=>value.steps[3].source='eox-bluemarble',
  value=>value.steps[3].coordinate[0]=180,
  value=>value.steps[2].credit.text='NASA Blue Marble · EOX · Обзорный снимок · детализация ниже',
  value=>{value.resources.requests[0].url=nasa;value.resources.requests[0].tile={z:4,x:0,y:3};},
  value=>value.steps[0].successfulRequestIds=[],
  value=>value.steps[0].successfulRequestIds=['eox-s2'],
  value=>value.steps[0].pendingRequestIds=['eox-bluemarble'],
  value=>value.steps[0].failedRequestIds=['eox-bluemarble'],
  value=>{value.resources.requests[0].finished=false;delete value.resources.requests[0].finishedSequence;},
  value=>value.resources.requests[0].status=404,
  value=>value.resources.requests[0].mimeType='text/html',
  value=>value.resources.requests[0].url=eox,
  value=>value.resources.discardedRequests=1,
  value=>value.toggles[0].select.events[0].trusted=false,
  value=>value.toggles[0].after.camera.zoom+=1,
  value=>value.toggles[1].after.rect.width-=15,
  value=>value.steps[5].viewport.dpr=3,
  value=>value.zooms.pop(),
  value=>value.zooms[0].after.camera.zoom=value.zooms[0].before.camera.zoom,
  value=>value.pans[0].events.push({type:'click',trusted:true}),
  value=>value.pans[0].after=structuredClone(value.pans[0].before),
  value=>value.pans=value.pans.filter(pan=>pan.stage!=='west-eox'),
  value=>value.screenshots.pop(),
 ];
 for(const change of changes){const invalid=structuredClone(fixture);change(invalid);assert.throws(()=>assertSatelliteContinuityAudit(invalid,profile,engine));}
});

test('capture sequence derives pending/errors from raw events and does not apply future failures to earlier frames',()=>{
 const make=()=>satelliteFixture('desktop-webgl','tropnik-canvas');
 const extra=(report,{finished=true,status=404}={})=>{
  const item={...structuredClone(report.resources.requests[0]),requestId:'late',phase:'dateline-native8',responsePhase:'dateline-native8',firstSequence:10,requestedSequence:10,responseSequence:11,finishedSequence:12,status};
  if(!finished){delete item.responseSequence;delete item.finishedSequence;delete item.status;delete item.mimeType;delete item.bytes;item.finished=false;}
  report.resources.requests.push(item);report.resources.observedRequests++;report.resources.sequence=finished?12:10;return item;
 };
 for(const settings of [{finished:true,status:404},{finished:false}]){
  const report=make();extra(report,settings);report.steps[1].resourceSequence=report.resources.sequence;
  assert.throws(()=>assertSatelliteContinuityAudit(report,report.profile,report.engine),/summary differs from raw capture events/,'Empty summary arrays cannot hide raw current-frame failure/pending events');
 }
 const future=make();extra(future);assert.equal(assertSatelliteContinuityAudit(future,future.profile,future.engine),future,'Later failures must not invalidate already captured earlier frames');
 const delayed=make();delayed.resources.requests[0].finishedSequence=10;delayed.resources.sequence=10;
 assert.equal(successfulSatelliteResources(satelliteResourcesAt(delayed.resources,9),'eox-bluemarble').some(item=>item.requestId==='eox-bluemarble'),false,'A transfer completed later cannot certify earlier imagery');
 assert.throws(()=>assertSatelliteContinuityAudit(delayed,delayed.profile,delayed.engine));
 const eastOnly=make();eastOnly.resources.requests.splice(1,1);eastOnly.resources.observedRequests--;
 for(const frame of [...eastOnly.steps,eastOnly.toggles[0].after,eastOnly.preload.after])if(frame.successfulRequestIds)frame.successfulRequestIds=frame.successfulRequestIds.filter(id=>id!=='eox-bluemarble-west');
 assert.throws(()=>assertSatelliteContinuityAudit(eastOnly,eastOnly.profile,eastOnly.engine),/committed bitmap has no completed public imagery response/);
 for(const frame of [...eastOnly.steps,eastOnly.toggles[0].after,eastOnly.preload.after])frame.customMap.tiles.imagery=frame.customMap.tiles.imagery.filter(tile=>((tile.x%2**tile.z)+2**tile.z)%2**tile.z!==255);
 assert.throws(()=>assertSatelliteContinuityAudit(eastOnly,eastOnly.profile,eastOnly.engine),/both dateline columns/);
});

function recoveredResetFixture(){
 const report=satelliteFixture('desktop-webgl','tropnik-canvas'),original=report.resources.requests[0],phase='dateline-native8';
 const failed={...structuredClone(original),requestId:'reset',phase,responsePhase:phase,failedPhase:phase,firstSequence:10,requestedSequence:10,responseSequence:11,failedSequence:12,error:'net::ERR_CONNECTION_RESET',canceled:false,finished:false};
 delete failed.finishedSequence;delete failed.bytes;
 const retry={...structuredClone(original),requestId:'retry',phase,responsePhase:phase,firstSequence:13,requestedSequence:13,responseSequence:14,finishedSequence:15};
 report.resources.requests.push(failed,retry);report.resources.observedRequests+=2;report.resources.sequence=15;
 const frame=report.steps[1];frame.resourceSequence=15;frame.successfulRequestIds.push('retry');frame.failedRequestIds=['reset'];
 frame.recoveredRequests=[{failedRequestId:'reset',retryRequestId:'retry',url:failed.url}];
 return{report,failed,retry,frame};
}

test('a reset remains raw failure evidence after a later complete response proves exact-URL recovery',()=>{
 for(const headersReceived of [false,true]){
  const {report,failed}=recoveredResetFixture();if(!headersReceived){delete failed.status;delete failed.responseSequence;delete failed.mimeType;delete failed.responsePhase;}
  const read=sequence=>satelliteRequestStateAt(report.resources,'eox-bluemarble',sequence,'dateline-native8');
  const broken=read(12);assert.deepEqual(broken.failed,['reset']);assert.deepEqual(broken.unrecovered,['reset']);assert.deepEqual(broken.recoveries,[]);
  const loading=read(14);assert.deepEqual(loading.pending,['retry']);assert.deepEqual(loading.unrecovered,['reset']);assert.deepEqual(loading.recoveries,[]);
  const completed=read(15);assert.deepEqual(completed.failed,['reset']);assert.deepEqual(completed.pending,[]);assert.deepEqual(completed.unrecovered,[]);
  assert.deepEqual(completed.recoveries,[{failedRequestId:'reset',retryRequestId:'retry',url:failed.url}]);
  assert.equal(completed.current.requests.find(item=>item.requestId==='reset').error,'net::ERR_CONNECTION_RESET','Recovery never deletes the original failure');
  assert.equal(assertSatelliteContinuityAudit(report,report.profile,report.engine),report);
 }
});

test('recovery proof rejects older, parallel, future, canceled, HTTP-error and mismatched image transfers',()=>{
 const mutations=[
  ({retry})=>{retry.firstSequence=1;retry.requestedSequence=1;retry.responseSequence=2;retry.finishedSequence=3;},
  ({retry})=>{retry.firstSequence=11;retry.requestedSequence=11;},
  ({retry,report})=>{retry.finishedSequence=16;report.resources.sequence=16;},
  ({retry})=>{retry.canceled=true;retry.error='net::ERR_ABORTED';retry.failedSequence=15;retry.finished=false;delete retry.finishedSequence;},
  ({retry})=>retry.status=404,
  ({retry})=>retry.mimeType='text/html',
  ({retry})=>retry.bytes=-1,
  ({retry})=>{retry.finished=false;delete retry.finishedSequence;},
  ({retry})=>{retry.error='net::ERR_CONNECTION_RESET';retry.failedSequence=15;retry.finished=false;delete retry.finishedSequence;},
  ({retry})=>retry.url=retry.url.replace('/0.jpg','/1.jpg'),
  ({retry})=>retry.tile.x=1,
  ({retry})=>retry.source='eox-s2',
  ({retry})=>retry.phase='dateline-overzoom',
  ({retry})=>delete retry.requestedSequence,
  ({retry})=>retry.responseSequence=retry.requestedSequence,
  ({failed})=>failed.status=404,
  ({failed})=>failed.status=503,
  ({failed})=>failed.error='net::ERR_FAILED',
  ({failed})=>failed.tile.x=1,
 ];
 for(const mutate of mutations){
  const fixture=recoveredResetFixture();mutate(fixture);
  const state=satelliteRequestStateAt(fixture.report.resources,'eox-bluemarble',15,'dateline-native8');
  assert.deepEqual(state.recoveries,[],String(mutate));assert.ok(state.unrecovered.includes('reset'),String(mutate));
 }
 const canceled=recoveredResetFixture();canceled.failed.canceled=true;
 assert.deepEqual(satelliteRequestStateAt(canceled.report.resources,'eox-bluemarble',15,'dateline-native8').recoveries,[],'A canceled transfer is never classified as an automatic network recovery');
});

test('a third successful request cannot hide an exhausted two-attempt network failure',()=>{
 const {report,retry}=recoveredResetFixture(),third={...structuredClone(retry),requestId:'third',firstSequence:16,requestedSequence:16,responseSequence:17,finishedSequence:18};
 retry.finished=false;delete retry.finishedSequence;delete retry.bytes;retry.error='net::ERR_CONNECTION_RESET';retry.failedSequence=15;retry.failedPhase='dateline-native8';retry.canceled=false;
 report.resources.requests.push(third);report.resources.observedRequests++;report.resources.sequence=18;
 const state=satelliteRequestStateAt(report.resources,'eox-bluemarble',18,'dateline-native8');
 assert.deepEqual(state.failed,['reset','retry']);assert.deepEqual(state.unrecovered,['reset']);assert.deepEqual(state.recoveries,[{failedRequestId:'retry',retryRequestId:'third',url:retry.url}]);
});

test('the continuity gate reconstructs recovery pairs and still rejects incomplete ground and forged summaries',()=>{
 for(const change of [
  ({frame})=>frame.failedRequestIds=[],
  ({frame})=>frame.recoveredRequests=[],
  ({frame})=>frame.recoveredRequests[0].retryRequestId='eox-bluemarble',
  ({frame})=>frame.unrecoveredRequestIds=['reset'],
  ({frame})=>frame.customMap.tiles.imagery=[],
  ({frame})=>frame.state='loading',
  ({frame})=>frame.credit.visible=false,
  ({report})=>report.schemaVersion=4,
 ]){const fixture=recoveredResetFixture();change(fixture);assert.throws(()=>assertSatelliteContinuityAudit(fixture.report,fixture.report.profile,fixture.report.engine));}
});

test('custom imagery requires a committed decoded batch, retained ground during preload and actual separable provider viewports',()=>{
 const valid=satelliteFixture('desktop-webgl','tropnik-canvas');
 for(const change of [
  value=>value.toggles[0].after.customMap.tiles.imagery=[],
  value=>value.toggles[0].after.customMap.tiles.imagery[0].x=1,
  value=>value.preload.pending.customMap.tiles.detail=[],
  value=>value.preload.pending.customMap.state.imageryLoading=false,
  value=>value.setupZooms[0].click.events[2].trusted=false,
  value=>value.setupZooms[0].after.camera.zoom=4,
  value=>value.steps[3].camera.zoom=4,
 ]){const invalid=structuredClone(valid);change(invalid);assert.throws(()=>assertSatelliteContinuityAudit(invalid,invalid.profile,invalid.engine));}
});

test('preload acceptance rejects early ground removal, stale/finished requests, unbounded holds and missing intermediate images',()=>{
 const make=()=>satelliteFixture('desktop-webgl','tropnik-canvas');
 const valid=make();assert.equal(assertSatellitePreload(valid.preload,valid.resources,'preload'),valid.preload);
 const changes=[
  report=>report.preload.pending.base.committed='satellite',
  report=>report.preload.pending.base.state='ready',
  report=>report.preload.pending.source='eox-bluemarble',
  report=>report.preload.pending.camera.zoom+=1,
  report=>report.preload.pending.resourceSequence=3,
  report=>report.preload.held.records[0].networkId='invented',
  report=>report.preload.held.records[0].resumedAt=150,
  report=>report.preload.held.closed=true,
  report=>report.preload.held.limit=1000,
  report=>report.preload.released.reason='timeout',
  report=>report.preload.released.errors=['resume failed'],
  report=>report.preload.released.records[0].resumedAt=null,
  report=>report.preload.screenshots.splice(1,1),
 ];
 for(const change of changes){const report=make();change(report);assert.throws(()=>assertSatellitePreload(report.preload,report.resources,'preload'));}
});

test('preload accepts the actual low-zoom overview batch without claiming detail or hiding missing ground',()=>{
 const make=()=>{
  const report=satelliteFixture('android-portrait','tropnik-canvas');
  for(const frame of [report.preload.before,report.preload.pending]){
   frame.base.committed='overview';frame.customMap.state.committedMode='overview';
   frame.customMap.tiles.detail=[];frame.customMap.tiles.relief=[];
  }
  return report;
 };
 const valid=make();assert.equal(assertSatellitePreload(valid.preload,valid.resources,'overview preload'),valid.preload);
 for(const change of [
  report=>report.preload.before.base.target='satellite',
  report=>report.preload.before.customMap.state.mode='overview',
  report=>report.preload.before.customMap.state.committedMode='detail',
  report=>{for(const frame of [report.preload.before,report.preload.pending,report.preload.after]){frame.camera.zoom=5;frame.customMap.camera.zoom=5;}},
  report=>report.preload.before.customMap.camera.zoom=3,
  report=>report.preload.before.customMap.tiles.overview=[],
  report=>report.preload.before.customMap.tiles.detail.push(structuredClone(report.preload.before.customMap.tiles.overview[0])),
  report=>report.preload.before.customMap.tiles.imagery.push(structuredClone(report.preload.after.customMap.tiles.imagery[0])),
  report=>report.preload.pending.customMap.tiles.overview=[],
 ]){const invalid=make();change(invalid);assert.throws(()=>assertSatellitePreload(invalid.preload,invalid.resources,'overview preload'));}
});

test('the native pan planner uses the nearest dateline world copy without writing map coordinates',()=>{
 const rect={left:0,top:68,width:412,height:847},camera={longitude:-179,latitude:67.5,zoom:4,tileSize:256};
 const point=projectMapPoint([180,67.5],camera,rect),dx=206-point.x,dy=491.5-point.y;
 assert.ok(Math.abs(dx)<12,'The 180° target must be one degree away, not a whole world');
 const plan=coastPanPlan(dx,dy,rect,true);assert.equal(plan.length,2);
 assert.ok(Math.abs(plan.reduce((sum,p)=>sum+p.dx,0)-dx)<1e-9);assert.ok(plan.every(p=>Math.hypot(p.dx,p.dy)>=24));
});

test('satellite intervals retain the unchanged strict mobile/desktop budgets',()=>{
 for(const mobile of [true,false]){
  const profile={name:mobile?'android-portrait':'desktop-webgl',mobile},limit=mobile?350:750;
  assert.deepEqual(satellitePerformanceIssues({performance:{layoutShift:.119,longestTaskMs:limit-.001}},profile),[]);
  const issues=satellitePerformanceIssues({performance:{layoutShift:.12,longestTaskMs:limit}},profile);assert.equal(issues.length,2);assert.equal(issues[1].limit,limit);assert.equal(issues[1].phase,'satellite-continuity');
 }
 assert.throws(()=>satellitePerformanceIssues({}, {name:'desktop-webgl',mobile:false}),/performance evidence/);
 const frame=satelliteFixture('desktop-webgl','tropnik-canvas').steps[0],changed=structuredClone(frame);changed.viewport.width-=15;
 assert.throws(()=>assertSatelliteCameraUnchanged(frame,changed,'satellite'),/viewport/);
});
