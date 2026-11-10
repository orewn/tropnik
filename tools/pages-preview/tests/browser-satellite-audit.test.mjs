import test from 'node:test';
import assert from 'node:assert/strict';
import {satelliteResource,observeSatelliteResources,successfulSatelliteResources,satelliteResourcesAt,satelliteTileContains,assertSatelliteContinuityAudit,assertSatelliteCameraUnchanged,satellitePerformanceIssues} from '../browser-satellite-audit.mjs';
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

for(const engine of ['leaflet','maplibre'])test(`${engine} continuity requires native gestures, provider transfers, lower-detail credit and camera-preserving toggles`,()=>{
 const profile=engine==='leaflet'?'android-portrait':'desktop-webgl',fixture=satelliteFixture(profile,engine);
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
 const make=()=>satelliteFixture('desktop-webgl','maplibre');
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
 for(const frame of [...eastOnly.steps,eastOnly.toggles[0].after])if(frame.successfulRequestIds)frame.successfulRequestIds=frame.successfulRequestIds.filter(id=>id!=='eox-bluemarble-west');
 assert.throws(()=>assertSatelliteContinuityAudit(eastOnly,eastOnly.profile,eastOnly.engine),/both dateline columns/);
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
 const frame=satelliteFixture('desktop-webgl','maplibre').steps[0],changed=structuredClone(frame);changed.viewport.width-=15;
 assert.throws(()=>assertSatelliteCameraUnchanged(frame,changed,'satellite'),/viewport/);
});
