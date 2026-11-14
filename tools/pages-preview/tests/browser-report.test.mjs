import {customMapFixture} from './custom-map-fixture.mjs';
import {mapModeFixture,mapModeSwitchesFixture} from './map-modes-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {CLOSE_TRAIL_FIXTURE,assertBrowserReport as verifyBrowserReport,assertRouteEdgeFrame,assertReliefPalette} from '../browser-report.mjs';
import {projectMapPoint,unprojectMapPoint} from '../map-projection.mjs';
import {directionHitAreasFixture} from './direction-hitareas-fixture.mjs';
import {catalogueFixture,layerMenusFixture,exploreExperienceFixture,styleCameraRoundtripFixture,mapWheelFixture} from './experience-fixture.mjs';
import {coastFixture} from './coast-fixture.mjs';
import {satelliteFixture} from './satellite-fixture.mjs';
import {smoothnessFixture} from './smoothness-fixture.mjs';
import {browserEnvironmentFixture,terrainMaskReportFixture} from './browser-environment-fixture.mjs';

const commit='a'.repeat(40);
const assertBrowserReport=(report,source)=>verifyBrowserReport(report,source,catalogueFixture);
const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
function closeTrail(profile,engine,mobile){
 const input=mobile?'touch':'mouse',step=1,inputs=[],frames=[];let zoom=14;
 for(const targetZoom of [11,14,17]){
  while(zoom!==targetZoom){
   const direction=targetZoom>zoom?1:-1,index=inputs.length;
   inputs.push({input,direction,before:zoom,after:zoom+direction*step,events:['pointerdown','pointerup','click'].map((type,event)=>({type,time:100+index*10+event,timestamp:100+index*10+(event?1:0),trusted:true,pointerType:input,pointerId:mobile?index+2:1}))});zoom+=direction*step;
  }
  const mapRect=rect(0,72,mobile?412:1000,mobile?700:928),camera={longitude:40.6887254,latitude:45.54436005,zoom,tileSize:256};
  const markers=CLOSE_TRAIL_FIXTURE.endpoints.map((coordinate,index)=>{
   const letter=['А','Б'][index],point=projectMapPoint(coordinate,camera,mapRect);
   return{role:'img',ariaLabel:`Край ${letter} исходной линии`,pointerEvents:'none',rect:rect(point.x-16,point.y-16,32,32),
    badge:{text:letter,visible:zoom!==11,pointerEvents:'none',rect:rect(point.x-16,point.y-16,32,32)},
    caption:{text:`Точка ${letter}`,visible:zoom===17,pointerEvents:'none',rect:rect(point.x-32,point.y+20,64,24)}};
  });
  frames.push({targetZoom,zoom,camera,mapRect,routeId:CLOSE_TRAIL_FIXTURE.routeId,inputCount:inputs.length,available:mapRect,scrollY:0,region:CLOSE_TRAIL_FIXTURE.region,queryRoute:CLOSE_TRAIL_FIXTURE.routeId,selectedRoute:'selected',imagery:'',sceneVisible:false,markers,overlays:[],reliefPalette:{engine,...(engine==='tropnik-canvas'?{bitmapInspection:customMapFixture({camera,routeId:CLOSE_TRAIL_FIXTURE.routeId})}:{})},screenshot:`${profile}-source-ends-z${zoom}.png`});
 }
 return{passed:true,input,region:CLOSE_TRAIL_FIXTURE.region,routeId:CLOSE_TRAIL_FIXTURE.routeId,geometryURL:CLOSE_TRAIL_FIXTURE.geometryURL,
  source:{featureCount:1,partCount:1,vertexCount:12,endpoints:CLOSE_TRAIL_FIXTURE.endpoints,sha256:'c'.repeat(64)},
  initialZoom:14,setupClicks:1,nativeZoomClicks:inputs.length,inputs,frames,visualReviewRequired:true,performance:{layoutShift:0,longestTaskMs:100},
  closeFraming:{required:false,passed:true,before:frames.at(-1),gestures:[]}};
}
function sheetGestures(){
 const drag=(name,from,to,positions,cancelled=false)=>({name,from,to,passed:true,input:'touch',cancelled,draggingCleared:true,maxTrackingErrorPx:0,pageScrollDeltaPx:0,heightDelta:0,samples:positions.map(panelTop=>({fingerY:panelTop+22,panelTop,expectedTop:panelTop,trackingErrorPx:0,pageScrollDeltaPx:0}))});
 return{passed:true,input:'touch',maxTrackingErrorPx:0,maxPageScrollDeltaPx:0,
  drags:[drag('open','closed','open',[420,360,260]),drag('close','open','closed',[280,340,440]),drag('open-again','closed','open',[420,360,260]),drag('close-again','open','closed',[280,340,440])],
  reversal:drag('reverse','closed','closed',[400,330,280,330,420]),cancelled:drag('cancel','closed','closed',[400,350],true),
  scroll:{passed:true,input:'touch',before:0,after:100,deltaPx:100,pageScrollDeltaPx:0,sheetDisplacementPx:0,selectionPreserved:true},
  tapAfterCancel:true,tapAfterDrag:true,listPositionRetained:true,selectionPreserved:true,finalState:'closed'};
}
function zoomDesign(profile,engine,mobile){
 const step=1,input=mobile?'touch':'mouse',high=10+4*step,edges=closeTrail(profile,engine,mobile);
 const burst=(direction,beforeZoom,afterZoom)=>({passed:true,input,count:4,receivedClicks:4,direction,step,beforeZoom,afterZoom,expectedZoom:afterZoom,eventSpanMs:30,durationMs:50,pageScrollDeltaPx:0,selectionPreserved:true,
  dispatchMode:'ordered-native',eventOrderVerified:true,producerDurationMs:1,firstInputLagMs:100,domTimeOrigin:10000,domSampleStartedAtMs:90,recentLongTasks:[],
  events:Array.from({length:4},(_,tap)=>['pointerdown','pointerup','click'].map((type,index)=>({type,time:100+tap*10+index*2,timestamp:100+tap*10+(index?2:0),trusted:true,pointerType:input,pointerId:mobile?tap+2:1}))).flat(),
  commands:[...(mobile?[]:['mouseMoved']),...Array.from({length:4},()=>mobile?['touchStart','touchEnd']:['mousePressed','mouseReleased']).flat()].map((type,index)=>({index,type,method:mobile?'Input.dispatchTouchEvent':'Input.dispatchMouseEvent',status:'fulfilled',sentAtEpochMs:10000+index*.1,ackAtEpochMs:10040+index,sentOffsetMs:index*.1,ackOffsetMs:40+index,ackDurationMs:40+index*.9})),
 });
 return{profile,engine,input:mobile?'touch':'mouse',schemaVersion:9,geometryPassed:true,visualReviewRequired:true,maximumZoom:18,minimumZoom:2,routeId:'kavkaz-8a',detailSteps:Array.from({length:17},(_,index)=>({zoom:index+2,modeState:mapModeFixture({camera:{longitude:40,latitude:43,zoom:index+2}}),...(engine==='tropnik-canvas'?{bitmapInspection:customMapFixture({camera:{longitude:40,latitude:43,zoom:index+2}})}:{})})),closeTrail:edges,coast:coastFixture(profile,engine),satelliteContinuity:satelliteFixture(profile,engine),
  performance:{layoutShift:0,longestTaskMs:100},performanceIntervals:{modes:{layoutShift:0,longestTaskMs:100},sourceEnds:edges.performance,satellite:{layoutShift:0,longestTaskMs:100}},
  zoomBurst:{passed:true,input,returnedToStart:true,increase:burst(1,10,high),decrease:burst(-1,high,10)},
  modeSwitches:mapModeSwitchesFixture(input),
  modes:{detail:{state:'checked'},relief:{state:'active',selectedControl:true,visualReviewRequired:true,keySteps:[2,5,8,11,14,18].map(zoom=>({targetZoom:zoom,zoom,mode:'relief',modeState:mapModeFixture({camera:{longitude:40,latitude:43,zoom}}),...(engine==='tropnik-canvas'?{bitmapInspection:customMapFixture({camera:{longitude:40,latitude:43,zoom}})}:{})})),sourceEvidence:{geoJSON:[],finishedReliefImageResponses:0,failedResponses:0,loadedReliefTiles:0}},satellite:{state:'active',visualReviewRequired:true}},
  screenshots:[...['detail','relief'].flatMap(mode=>[2,5,8,11,14,18].map(zoom=>({file:`${profile}-${mode}-z${zoom}.png`,mode,zoom,bytes:10000,sha256:'a'.repeat(64)}))),...edges.frames.map(frame=>({file:frame.screenshot,mode:'source-ends',zoom:frame.zoom,bytes:10000,sha256:'b'.repeat(64)}))]};
}
function evidence(){
 return{verified:true,environment:browserEnvironmentFixture(commit),terrainMask:terrainMaskReportFixture(commit),catalogue:structuredClone(catalogueFixture),sourceCommit:commit,mapInteractionSchemaVersion:6,
  offlineSafety:{schemaVersion:1,passed:true,profile:'android-portrait',savedThroughUI:true,workerControlled:true,coldNavigation:true,offline:true,titleRestored:true,contactRestored:true,draftExplicit:true,privateApiNotCached:true,nativeInputs:4,inputs:['route-title','region','leader-name','leader-phone'].map(id=>({selector:'#'+id,passed:true,focusedBeforeTyping:true,valueLength:10,events:[{type:'input',trusted:true,id,valueLength:10}]})),networkSuccessfulResponses:0,originTransport:{method:'origin-socket-destroy',active:false,startedAt:'2026-11-10T00:00:00Z',restoredAt:'2026-11-10T00:00:01Z',blockedRequests:1,requests:[{path:'/tropnik/_offline-transport-probe',method:'GET'}],probe:{passed:true,errorCode:'ECONNRESET',path:'/tropnik/_offline-transport-probe'}},screenshot:{bytes:10000,sha256:'f'.repeat(64)}},
  profiles:['compact-android','iphone-portrait','android-portrait','phone-landscape'].map(name=>({name,engine:'tropnik-canvas',interactionTested:true,sheetTested:true,sheetGestures:sheetGestures(),...(name==='phone-landscape'?{}:{layerMenus:layerMenusFixture()}),sheetHeightDelta:0,layoutShift:0,longestTaskMs:100})),
  desktopProfiles:[{name:'desktop-webgl',engine:'tropnik-canvas',coarse:false,mapInteractionTested:true}],
  zoomDesigns:[zoomDesign('android-portrait','tropnik-canvas',true),zoomDesign('desktop-webgl','tropnik-canvas',false)],
  siteSmoothness:[smoothnessFixture('android-portrait','tropnik-canvas'),smoothnessFixture('desktop-webgl','tropnik-canvas')],
  mapInteractions:[['android-portrait','tropnik-canvas',true],['desktop-webgl','tropnik-canvas',false]].map(([profile,engine,mobile])=>({profile,engine,mobile,passed:true,directionHitAreas:directionHitAreasFixture(engine,mobile),experience:exploreExperienceFixture(mobile,'route',engine),...(mobile?{}:{styleCameraRoundtrip:styleCameraRoundtripFixture('route',{engine}),wheelOwnership:mapWheelFixture()}),catalogScroll:mobile?{passed:true,input:'touch',deltaPx:100,scrollHeightDelta:0,pageScrollDeltaPx:0,sheetDisplacementPx:0}:null,firstDirection:[{selected:'altai'}],secondDirection:[{selected:'baikal'}],route:{id:'route',offsetPx:14},line:{route:'route',clicked:true,selectionRetained:true,reopened:mobile},returnedToRegion:true,returnedToDirections:true,countryCameraRestored:true,polygon:{id:'territory'},gestures:{zoomInput:mobile?'touch-control':'mouse-wheel',beforeZoom:5,afterZoom:6,dragged:true,selectionPreserved:true,resizedTo:{width:900,height:412},postResizePolygon:'territory'},longestTaskMs:100,layoutShift:0}))};
}
test('both upload and public verification require real mobile and desktop map interaction evidence',()=>{
 const report=evidence();assert.equal(assertBrowserReport(report,commit),report);
 const changes=[
  value=>delete value.offlineSafety,
  value=>value.offlineSafety.offline=false,
  value=>value.offlineSafety.coldNavigation=false,
  value=>value.offlineSafety.savedThroughUI=false,
  value=>value.offlineSafety.networkSuccessfulResponses=1,
  value=>delete value.offlineSafety.originTransport,
  value=>value.offlineSafety.originTransport.probe.passed=false,
  value=>value.offlineSafety.originTransport.active=true,
  value=>delete value.offlineSafety.originTransport.restoredAt,
  value=>value.offlineSafety.draftExplicit=false,
  value=>value.offlineSafety.contactRestored=false,
  value=>value.offlineSafety.inputs[0].focusedBeforeTyping=false,
  value=>value.offlineSafety.inputs[0].events[0].id='region',
  value=>value.offlineSafety.inputs[0].events[0].trusted=false,
  value=>delete value.mapInteractionSchemaVersion,
  value=>value.mapInteractionSchemaVersion=2,
  value=>value.sourceCommit='b'.repeat(40),
  value=>value.profiles.pop(),
  value=>value.profiles[0].sheetTested=false,
  value=>value.profiles[0].layoutShift=.12,
  value=>value.profiles[0].longestTaskMs=350,
  value=>value.desktopProfiles[0].engine='leaflet',
  value=>value.desktopProfiles[0].coarse=true,
  value=>value.mapInteractions.pop(),
  value=>delete value.siteSmoothness,
  value=>value.siteSmoothness.pop(),
  value=>value.mapInteractions[0].layoutShift=.12,
  value=>delete value.profiles[0].layerMenus,
  value=>delete value.profiles[1].layerMenus,
  value=>delete value.profiles[2].layerMenus,
  value=>delete value.mapInteractions[0].experience,
  value=>delete value.mapInteractions[1].experience,
  value=>delete value.mapInteractions[1].styleCameraRoundtrip,
  value=>value.mapInteractionSchemaVersion=5,
  value=>delete value.mapInteractions[1].wheelOwnership,
  value=>value.mapInteractions[1].wheelOwnership.bursts[1].events[0].defaultPrevented=false,
  value=>value.mapInteractions[1].wheelOwnership.bursts[1].events[0].scrollY=468,
  value=>value.mapInteractions[1].wheelOwnership.bursts.pop(),
  value=>value.mapInteractions[1].wheelOwnership.bursts.forEach(burst=>{burst.point.kind='marker';}),
  value=>value.mapInteractions[1].wheelOwnership.bursts[0].commands[1].index=0,
  value=>value.mapInteractions[1].wheelOwnership.bursts[0].commands[1].sentOffsetMs=-1,
  value=>value.mapInteractions[1].wheelOwnership.bursts[0].commands[1].ackOffsetMs=-1,
  value=>value.mapInteractions[1].wheelOwnership.bursts[0].eventSpanMs=30000,
  value=>value.mapInteractions[1].wheelOwnership.sidebar.after.scrollTop=0,
  value=>value.mapInteractions[0].experience=exploreExperienceFixture(true,'another-route'),
  value=>value.mapInteractions[1].styleCameraRoundtrip=styleCameraRoundtripFixture('another-route'),
  value=>delete value.mapInteractions[0].directionHitAreas,
  value=>delete value.mapInteractions[1].directionHitAreas,
  value=>value.mapInteractions[0].directionHitAreas.actions[0].events[2].trusted=false,
  value=>value.mapInteractions[0].route.offsetPx=6,
  value=>value.mapInteractions[0].line.reopened=false,
  value=>value.mapInteractions[0].countryCameraRestored=false,
  value=>delete value.mapInteractions[0].catalogScroll,
  value=>value.mapInteractions[0].catalogScroll.scrollHeightDelta=132,
  value=>value.mapInteractions[0].gestures.dragged=false,
  value=>delete value.mapInteractions[0].gestures.postResizePolygon,
 ];
 for(const change of changes){const bad=evidence();change(bad);assert.throws(()=>assertBrowserReport(bad,commit));}
});
test('publication rejects missing, synthetic, mismatched or Canvas-substituted WebGL proof',()=>{
 const missingSource=evidence();missingSource.sourceCommit=null;missingSource.environment.sourceCommit=null;
 missingSource.terrainMask.sourceCommit=null;missingSource.terrainMask.environment.sourceCommit=null;
 assert.throws(()=>verifyBrowserReport(missingSource,null,catalogueFixture),/exact source commit/);
 const changes=[
  value=>delete value.environment,value=>delete value.terrainMask,
  value=>delete value.environment.nativeSurface,
  value=>{value.environment.nativeSurface.viewport.innerWidth=780;value.environment.nativeSurface.viewport.innerHeight=580;},
  value=>value.environment.commandLine=value.environment.commandLine.replace('--use-angle=swiftshader-webgl','--use-angle=swiftshader'),
  value=>value.environment.gpu.featureStatus.gpu_compositing='enabled',
  value=>value.terrainMask.evidence='synthetic-pixels',value=>value.terrainMask.environment.browser.revision='other-revision',
  value=>value.terrainMask.sourceCommit='e'.repeat(40),value=>value.terrainMask.cases[0].renderer='canvas2d',
  value=>value.terrainMask.cases[1].frames.at(-1).renderer='canvas2d',value=>value.terrainMask.cases[1].recovery.trusted=false,
 ];
 for(const change of changes){const bad=evidence();change(bad);assert.throws(()=>assertBrowserReport(bad,commit));}
});
test('publication accepts deferred native clicks only with the matching completed pointer pairs',()=>{
 const report=evidence();
 for(const design of report.zoomDesigns)for(const key of ['increase','decrease']){
  const burst=design.zoomBurst[key],clicks=burst.events.filter(event=>event.type==='click'),pointers=burst.events.filter(event=>event.type!=='click');
  burst.events=[...pointers,...clicks].map((event,index)=>({...event,time:100+index}));
  burst.eventSpanMs=3;
 }
 assert.equal(assertBrowserReport(report,commit),report);
 const bad=structuredClone(report);bad.zoomDesigns[0].zoomBurst.increase.events[8].pointerId=999;
 assert.throws(()=>assertBrowserReport(bad,commit),/another pointer pair/);
});
test('publication rejects the exact mobile and desktop long-task boundaries even with complete zoom evidence',()=>{
 for(const [index,limit] of [[0,350],[1,750]]){
  const below=evidence();below.mapInteractions[index].longestTaskMs=limit-1;
  assert.equal(assertBrowserReport(below,commit),below);
  for(const duration of [limit,limit+9,NaN]){
   const over=evidence();over.mapInteractions[index].longestTaskMs=duration;
   assert.throws(()=>assertBrowserReport(over,commit));
  }
 }
});
test('publication cannot hide all-mode freezes or source-end layout shifts behind a passing satellite interval',()=>{
 for(const [index,limit]of [[0,350],[1,750]])for(const phase of ['modes','sourceEnds'])for(const [metric,value]of [['longestTaskMs',limit],['layoutShift',.12]]){
  const report=evidence(),design=report.zoomDesigns[index];design.performanceIntervals[phase][metric]=value;
  if(phase==='sourceEnds')design.closeTrail.performance[metric]=value;
  design.performance[metric]=value;assert.throws(()=>assertBrowserReport(report,commit),/performance budget/);
 }
});
test('zoom evidence requires all increments and keeps unavailable imagery explicit',()=>{
 const changes=[
  value=>delete value.zoomDesigns,
  value=>value.zoomDesigns.pop(),
  value=>value.zoomDesigns[0].geometryPassed=false,
  value=>value.zoomDesigns[0].schemaVersion=1,
  value=>value.zoomDesigns[0].schemaVersion=2,
  value=>value.zoomDesigns[0].schemaVersion=3,
  value=>value.zoomDesigns[0].schemaVersion=4,
  value=>value.zoomDesigns[0].schemaVersion=5,
  value=>value.zoomDesigns[0].schemaVersion=6,
  value=>delete value.zoomDesigns[0].satelliteContinuity,
  value=>value.zoomDesigns[0].satelliteContinuity.steps[0].resolution='detail',
  value=>value.zoomDesigns[0].satelliteContinuity.resources.requests[0].finished=false,
  value=>value.zoomDesigns[0].satelliteContinuity.performance.longestTaskMs=350,
  value=>value.zoomDesigns[1].satelliteContinuity.performance.longestTaskMs=750,
  value=>delete value.zoomDesigns[0].performanceIntervals.modes,
  value=>value.zoomDesigns[0].performanceIntervals.modes.longestTaskMs=130,
  value=>value.zoomDesigns[0].performanceIntervals.sourceEnds={layoutShift:0,longestTaskMs:0},
  value=>delete value.zoomDesigns[0].coast,
  value=>value.zoomDesigns[0].coast.steps.pop(),
  value=>value.zoomDesigns[0].coast.steps[0].pending=1,
  value=>value.zoomDesigns[0].coast.steps[0].ready=false,
  value=>value.zoomDesigns[0].coast.steps[0].error='cell-integrity',
  value=>value.zoomDesigns[0].coast.steps[0].version='e'.repeat(16),
  value=>value.zoomDesigns[0].coast.steps[0].centerErrorPx=20,
  value=>value.zoomDesigns[0].coast.steps[4].lod='regional',
  value=>value.zoomDesigns[0].coast.steps[4].cells=[],
  value=>value.zoomDesigns[0].coast.resources[1].finished=false,
  value=>value.zoomDesigns[0].coast.pans[0].events[0].trusted=false,
  value=>value.zoomDesigns[0].coast.screenshots.pop(),
  value=>value.zoomDesigns[0].visualReviewRequired=false,
  value=>value.zoomDesigns[0].detailSteps.splice(6,1),
  value=>value.zoomDesigns[0].detailSteps.pop(),
  value=>value.zoomDesigns[0].screenshots.pop(),
  value=>delete value.zoomDesigns[0].modes.satellite,
  value=>delete value.zoomDesigns[0].modes.relief,
  value=>value.zoomDesigns[0].modes.relief.selectedControl=false,
  value=>value.zoomDesigns[0].modes.relief.keySteps.pop(),
  value=>value.zoomDesigns[0].modes.relief.keySteps[2].zoom=11,
  value=>delete value.zoomDesigns[0].modes.relief.sourceEvidence,
  value=>delete value.zoomDesigns[0].modeSwitches,
  value=>value.zoomDesigns[0].modeSwitches[0].canvasRetained=false,
  value=>value.zoomDesigns[0].modeSwitches[0].after.terrainScenes=1,
  value=>delete value.zoomDesigns[0].zoomBurst,
  value=>value.zoomDesigns[0].zoomBurst.increase.receivedClicks=3,
  value=>value.zoomDesigns[0].zoomBurst.increase.afterZoom-=.75,
  value=>value.zoomDesigns[0].zoomBurst.increase.eventSpanMs=200,
  value=>value.zoomDesigns[0].zoomBurst.increase.dispatchMode='serial-ack',
  value=>value.zoomDesigns[0].zoomBurst.increase.events[1].type='click',
  value=>value.zoomDesigns[0].zoomBurst.increase.events[2].trusted=false,
  value=>delete value.zoomDesigns[0].zoomBurst.increase.events[2].pointerId,
  value=>value.zoomDesigns[0].zoomBurst.increase.events[2].timestamp+=1,
  value=>value.zoomDesigns[0].zoomBurst.increase.commands[3].status='rejected',
  value=>delete value.zoomDesigns[0].zoomBurst.increase.commands,
  value=>value.zoomDesigns[0].zoomBurst.increase.recentLongTasks=Array(33).fill({duration:60}),
  value=>value.zoomDesigns[0].zoomBurst.decrease.afterZoom+=.75,
 ];
 for(const change of changes){const bad=evidence();change(bad);assert.throws(()=>assertBrowserReport(bad,commit));}
 const fallback=evidence();
 fallback.zoomDesigns[0].modes.satellite={state:'fallback',status:'External imagery did not load',visualReviewRequired:true};
 assert.throws(()=>assertBrowserReport(fallback,commit),'Unloaded satellite imagery cannot become a rendering PASS');
});
test('publication requires native single-line source-end coverage and all three review images',()=>{
 const changes=[
  audit=>{audit.passed=false;},
  audit=>{audit.input='mouse';},
  audit=>{audit.routeId='kavkaz-8a';},
  audit=>{audit.geometryURL='/invented.geojson';},
  audit=>{audit.source.partCount=2;},
  audit=>{audit.source.vertexCount=11;},
  audit=>{audit.source.endpoints=[[0,0],[1,1]];},
  audit=>{audit.setupClicks=4;},
  audit=>{audit.nativeZoomClicks--;},
  audit=>{audit.inputs[0].events[2].trusted=false;},
  audit=>{audit.inputs[1].after-=.75;},
  audit=>{audit.frames.pop();},
  audit=>{audit.frames[1].targetZoom=17;},
  audit=>{audit.frames[1].screenshot=audit.frames[0].screenshot;},
  audit=>{audit.frames[1].markers.push(audit.frames[1].markers[0]);},
  audit=>{audit.frames[1].markers[0].badge.visible=false;},
  audit=>{audit.frames[2].markers[0].pointerEvents='auto';},
 ];
 for(const change of changes){const bad=evidence();change(bad.zoomDesigns[0].closeTrail);assert.throws(()=>assertBrowserReport(bad,commit));}
 const missing=evidence();delete missing.zoomDesigns[0].closeTrail;assert.throws(()=>assertBrowserReport(missing,commit),/single-line source-end coverage/);
});
test('source-end geometry rejects overlapping badges and cross-end labels from actual rendered rectangles',()=>{
 const audit=closeTrail('android-portrait','tropnik-canvas',true),crowded=structuredClone(audit.frames[0]),separated=structuredClone(audit.frames[1]);
 assert.equal(assertRouteEdgeFrame(crowded,'Crowded source ends'),true,'Both passive source nodes may stay hidden at the crowded scale');
 for(const marker of crowded.markers)marker.badge.visible=true;
 assert.throws(()=>assertRouteEdgeFrame(crowded,'Observed zoom11'),/badge overlaps .* badge/);
 assert.equal(assertRouteEdgeFrame(separated,'Separated source ends',{requireBothVisible:true}),true);
 for(const marker of separated.markers)marker.caption.visible=true;
 assert.throws(()=>assertRouteEdgeFrame(separated,'Observed zoom14'),/caption overlaps .* badge|badge overlaps .* caption/,'Separate badges do not excuse a label covering the other end');
 const shifted=structuredClone(audit.frames[1]);shifted.markers[0].rect.left+=10;shifted.markers[0].rect.right+=10;
 assert.throws(()=>assertRouteEdgeFrame(shifted,'Shifted source marker'),/original coordinates/,'Collision avoidance must never move the source coordinate');
});
test('publication rejects missing or stale committed relief from the own renderer',()=>{
 const valid={engine:'tropnik-canvas',bitmapInspection:customMapFixture()};
 assert.equal(assertReliefPalette(valid,'actual relief','tropnik-canvas'),true);
 for(const mutate of [
  value=>value.bitmapInspection.state.committedMode='overview',
  value=>value.bitmapInspection.state.loading=true,
  value=>value.bitmapInspection.state.reliefReady=false,
  value=>value.bitmapInspection.tiles.relief=[],
  value=>value.bitmapInspection.drawRevision=0,
  value=>delete value.bitmapInspection,
 ]){const changed=structuredClone(valid);mutate(changed);assert.throws(()=>assertReliefPalette(changed,'invalid relief','tropnik-canvas'));}
});
test('publication requires native mode switches, one mounted map and preserved camera and route',()=>{
 for(const change of [
  value=>value.modeSwitches.pop(),
  value=>value.modeSwitches[0].events[2].trusted=false,
  value=>value.modeSwitches[0].selector='.layer-menu button',
  value=>value.modeSwitches[0].after.camera.center[0]+=.01,
  value=>value.modeSwitches[0].after.camera.zoom+=.02,
  value=>value.modeSwitches[0].after.camera.bearingDegrees=20,
  value=>value.modeSwitches[0].after.routeId='another-route',
  value=>value.modeSwitches[0].after.drawnRoute='',
  value=>value.modeSwitches[0].after.state.loading=true,
  value=>value.modeSwitches[0].after.drawRevision=value.modeSwitches[0].before.drawRevision,
  value=>value.modeSwitches[0].after.tiles.imagery=0,
  value=>value.modeSwitches[1].after.controls[1].pressed='true',
  value=>value.modeSwitches[1].after.controls.push({label:'3D',pressed:'false',disabled:false}),
  value=>value.detailSteps[4].modeState.terrainScenes=1,
  value=>value.modes.relief.keySteps[2].modeState.state.reliefReady=false,
 ]){const invalid=evidence();change(invalid.zoomDesigns[0]);assert.throws(()=>assertBrowserReport(invalid,commit));}
});
test('publication requires both full close-up annotations inside the map and clear of interface panels',()=>{
 const changes=[
  audit=>delete audit.closeFraming,
  audit=>audit.frames[2].markers[0].caption.visible=false,
  audit=>audit.frames[2].markers[0].caption.rect=rect(-30,250,64,24),
  audit=>audit.frames[2].overlays=[{kind:'map-context',rect:{...audit.frames[2].markers[0].badge.rect}}],
  audit=>audit.closeFraming.required=true,
 ];
 for(const change of changes){const bad=evidence();change(bad.zoomDesigns[0].closeTrail);assert.throws(()=>assertBrowserReport(bad,commit));}
});
test('publication requires native pan delivery, unchanged scale and source coordinates when the close frame was initially clipped',()=>{
 function panned(){
  const value=evidence(),audit=value.zoomDesigns[0].closeTrail,after=audit.frames[2],before=structuredClone(after),dx=200,dy=200;
  const [longitude,latitude]=unprojectMapPoint({x:after.mapRect.left+after.mapRect.width/2+dx,y:after.mapRect.top+after.mapRect.height/2+dy},after.camera,after.mapRect);
  before.camera={...before.camera,longitude,latitude};
  before.markers.forEach((marker,index)=>{
   const point=projectMapPoint(CLOSE_TRAIL_FIXTURE.endpoints[index],before.camera,before.mapRect);
   marker.rect=rect(point.x-16,point.y-16,32,32);marker.badge.rect={...marker.rect};marker.caption.rect=rect(point.x-32,point.y+20,64,24);
  });
  const start={x:80,y:280},end={x:280,y:480};
  const types=['touchStart',...Array(12).fill('touchMove'),'touchEnd'];
  const commands=types.map((type,index)=>{
   const progress=Math.min(1,index/12),sentOffsetMs=index*30+(index===types.length-1?200:0);
   return{type,method:'Input.dispatchTouchEvent',x:start.x+dx*progress,y:start.y+dy*progress,status:'fulfilled',sentOffsetMs,ackOffsetMs:sentOffsetMs+1};
  });
  const pan={input:'touch',start,end,delta:{dx,dy},holdBeforeReleaseMs:200,durationMs:commands.at(-1).ackOffsetMs,commands,canvasPathVerified:true,before,after,
   events:['pointerdown','pointerup'].map((type,index)=>({type,time:1000+index*700,pointerId:91,pointerType:'touch',trusted:true,...(index?end:start)}))};
  audit.closeFraming={required:true,passed:true,before,gestures:[pan]};return value;
 }
 const good=panned();assert.equal(assertBrowserReport(good,commit),good);
 const changes=[
  pan=>pan.events[1].trusted=false,
  pan=>pan.events[0].pointerId=92,
  pan=>pan.commands[5].x+=10,
  pan=>pan.commands.at(-1).sentOffsetMs=pan.commands.at(-2).ackOffsetMs+20,
  pan=>pan.canvasPathVerified=false,
  pan=>pan.before.queryRoute='another-route',
  pan=>pan.after.zoom=18,
 ];
 for(const change of changes){const bad=panned();change(bad.zoomDesigns[0].closeTrail.closeFraming.gestures[0]);assert.throws(()=>assertBrowserReport(bad,commit));}
 const absent=panned();absent.zoomDesigns[0].closeTrail.closeFraming.gestures=[];assert.throws(()=>assertBrowserReport(absent,commit));
});
test('old tap-only receipts and sticky native sheet gestures cannot pass publication',()=>{
 const changes=[
  value=>value.mapInteractionSchemaVersion=1,
  value=>delete value.profiles[0].sheetGestures,
  value=>value.profiles[0].sheetGestures.drags.pop(),
  value=>value.profiles[0].sheetGestures.drags[0].input='mouse',
  value=>value.profiles[0].sheetGestures.drags[0].maxTrackingErrorPx=3.1,
  value=>value.profiles[0].sheetGestures.drags[0].samples[0].panelTop+=10,
  value=>value.profiles[0].sheetGestures.drags[0].samples[1].pageScrollDeltaPx=2,
  value=>value.profiles[0].sheetGestures.drags[0].heightDelta=2,
  value=>value.profiles[0].sheetGestures.drags[0].draggingCleared=false,
  value=>value.profiles[0].sheetGestures.reversal.samples=value.profiles[0].sheetGestures.drags[0].samples,
  value=>value.profiles[0].sheetGestures.cancelled.cancelled=false,
  value=>value.profiles[0].sheetGestures.cancelled.to='open',
  value=>value.profiles[0].sheetGestures.scroll.deltaPx=0,
  value=>value.profiles[0].sheetGestures.scroll.sheetDisplacementPx=10,
  value=>value.profiles[0].sheetGestures.scroll.pageScrollDeltaPx=10,
  value=>value.profiles[0].sheetGestures.tapAfterCancel=false,
  value=>value.profiles[0].sheetGestures.tapAfterDrag=false,
  value=>value.profiles[0].sheetGestures.listPositionRetained=false,
  value=>value.profiles[0].sheetGestures.finalState='open',
 ];
 for(const change of changes){const bad=evidence();change(bad);assert.throws(()=>assertBrowserReport(bad,commit));}
});

test('publication requires all Relief review scales and rejects the removed product scene',()=>{
 const valid=evidence();assert.equal(assertBrowserReport(valid,commit),valid);
 for(const change of [
  value=>{const images=value.zoomDesigns[0].screenshots;images.splice(images.findIndex(image=>image.mode==='relief'),1);},
  value=>value.zoomDesigns[0].modes.scene3d={state:'ready'},
  value=>value.zoomDesigns[0].modes.relief.keySteps[0].modeState.canvasCount=2,
  value=>value.zoomDesigns[0].modes.relief.keySteps[0].modeState.pitch=30,
 ]){const invalid=evidence();change(invalid);assert.throws(()=>assertBrowserReport(invalid,commit));}
});
