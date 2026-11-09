import test from 'node:test';
import assert from 'node:assert/strict';
import {assertBrowserReport} from '../browser-report.mjs';

const commit='a'.repeat(40);
function sheetGestures(){
 const drag=(name,from,to,positions,cancelled=false)=>({name,from,to,passed:true,input:'touch',cancelled,draggingCleared:true,maxTrackingErrorPx:0,pageScrollDeltaPx:0,heightDelta:0,samples:positions.map(panelTop=>({fingerY:panelTop+22,panelTop,expectedTop:panelTop,trackingErrorPx:0,pageScrollDeltaPx:0}))});
 return{passed:true,input:'touch',maxTrackingErrorPx:0,maxPageScrollDeltaPx:0,
  drags:[drag('open','closed','open',[420,360,260]),drag('close','open','closed',[280,340,440]),drag('open-again','closed','open',[420,360,260]),drag('close-again','open','closed',[280,340,440])],
  reversal:drag('reverse','closed','closed',[400,330,280,330,420]),cancelled:drag('cancel','closed','closed',[400,350],true),
  scroll:{passed:true,input:'touch',before:0,after:100,deltaPx:100,pageScrollDeltaPx:0,sheetDisplacementPx:0,selectionPreserved:true},
  tapAfterCancel:true,tapAfterDrag:true,listPositionRetained:true,selectionPreserved:true,finalState:'closed'};
}
function zoomDesign(profile,engine,mobile){
 const step=mobile?.75:1,input=mobile?'touch':'mouse',high=10+4*step;
 const burst=(direction,beforeZoom,afterZoom)=>({passed:true,input,count:4,receivedClicks:4,direction,step,beforeZoom,afterZoom,expectedZoom:afterZoom,eventSpanMs:30,durationMs:50,pageScrollDeltaPx:0,selectionPreserved:true,
  dispatchMode:'ordered-native',eventOrderVerified:true,producerDurationMs:1,firstInputLagMs:100,domTimeOrigin:10000,domSampleStartedAtMs:90,recentLongTasks:[],
  events:Array.from({length:4},(_,tap)=>['pointerdown','pointerup','click'].map((type,index)=>({type,time:100+tap*10+index*2,timestamp:100+tap*10+(index?2:0),trusted:true,pointerType:input,pointerId:mobile?tap+2:1}))).flat(),
  commands:[...(mobile?[]:['mouseMoved']),...Array.from({length:4},()=>mobile?['touchStart','touchEnd']:['mousePressed','mouseReleased']).flat()].map((type,index)=>({index,type,method:mobile?'Input.dispatchTouchEvent':'Input.dispatchMouseEvent',status:'fulfilled',sentAtEpochMs:10000+index*.1,ackAtEpochMs:10040+index,sentOffsetMs:index*.1,ackOffsetMs:40+index,ackDurationMs:40+index*.9})),
 });
 return{profile,engine,input:mobile?'touch':'mouse',schemaVersion:3,geometryPassed:true,visualReviewRequired:true,maximumZoom:18,minimumZoom:2,routeId:'kavkaz-8a',detailSteps:Array.from({length:17},(_,index)=>({zoom:index+2})),
  zoomBurst:{passed:true,input,returnedToStart:true,increase:burst(1,10,high),decrease:burst(-1,high,10)},
  modes:{detail:{state:'checked'},overview:{state:'active',selectedControl:true,visualReviewRequired:true,keySteps:[2,5,8,11,14,18].map(zoom=>({targetZoom:zoom,zoom,mode:'saved-overview'})),sourceEvidence:{geoJSON:[],finishedReliefImageResponses:0,failedResponses:0,loadedReliefTiles:0}},satellite:{state:'active',visualReviewRequired:true},terrain:{state:mobile?'not-offered':'active'},scene3d:{state:'ready',retainedMapNoticeVisible:false,zoomInputs:28,resetInput:true,imageChanged:true,visualReviewRequired:true}},
  screenshots:['detail','saved-overview'].flatMap(mode=>[2,5,8,11,14,18].map(zoom=>({file:`${profile}-${mode}-z${zoom}.png`,mode,zoom,bytes:10000,sha256:'a'.repeat(64)})))};
}
function evidence(){
 return{verified:true,sourceCommit:commit,mapInteractionSchemaVersion:2,
  profiles:['compact-android','iphone-portrait','android-portrait','phone-landscape'].map(name=>({name,engine:'leaflet',interactionTested:true,sheetTested:true,sheetGestures:sheetGestures(),sheetHeightDelta:0,layoutShift:0,longestTaskMs:100})),
  desktopProfiles:[{name:'desktop-webgl',engine:'maplibre',coarse:false,mapInteractionTested:true}],
  zoomDesigns:[zoomDesign('android-portrait','leaflet',true),zoomDesign('desktop-webgl','maplibre',false)],
  mapInteractions:[['android-portrait','leaflet',true],['desktop-webgl','maplibre',false]].map(([profile,engine,mobile])=>({profile,engine,mobile,passed:true,catalogScroll:mobile?{passed:true,input:'touch',deltaPx:100,scrollHeightDelta:0,pageScrollDeltaPx:0,sheetDisplacementPx:0}:null,firstDirection:[{selected:'altai'}],secondDirection:[{selected:'baikal'}],route:{id:'route',offsetPx:14},line:{route:'route',clicked:true,selectionRetained:true,reopened:mobile},returnedToRegion:true,returnedToDirections:true,countryCameraRestored:true,polygon:{id:'territory'},gestures:{zoomInput:mobile?'touch-control':'mouse-wheel',beforeZoom:5,afterZoom:6,dragged:true,selectionPreserved:true,resizedTo:{width:900,height:412},postResizePolygon:'territory'},longestTaskMs:100}))};
}
test('both upload and public verification require real mobile and desktop map interaction evidence',()=>{
 const report=evidence();assert.equal(assertBrowserReport(report,commit),report);
 const changes=[
  value=>delete value.mapInteractionSchemaVersion,
  value=>value.sourceCommit='b'.repeat(40),
  value=>value.profiles.pop(),
  value=>value.profiles[0].sheetTested=false,
  value=>value.profiles[0].layoutShift=.12,
  value=>value.profiles[0].longestTaskMs=350,
  value=>value.desktopProfiles[0].engine='leaflet',
  value=>value.desktopProfiles[0].coarse=true,
  value=>value.mapInteractions.pop(),
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
test('zoom evidence requires all increments and keeps unavailable imagery explicit',()=>{
 const changes=[
  value=>delete value.zoomDesigns,
  value=>value.zoomDesigns.pop(),
  value=>value.zoomDesigns[0].geometryPassed=false,
  value=>value.zoomDesigns[0].schemaVersion=1,
  value=>value.zoomDesigns[0].schemaVersion=2,
  value=>value.zoomDesigns[0].visualReviewRequired=false,
  value=>value.zoomDesigns[0].detailSteps.splice(6,1),
  value=>value.zoomDesigns[0].detailSteps.pop(),
  value=>value.zoomDesigns[0].screenshots.pop(),
  value=>delete value.zoomDesigns[0].modes.satellite,
  value=>delete value.zoomDesigns[0].modes.overview,
  value=>value.zoomDesigns[0].modes.overview.selectedControl=false,
  value=>value.zoomDesigns[0].modes.overview.keySteps.pop(),
  value=>value.zoomDesigns[0].modes.overview.keySteps[2].zoom=11,
  value=>delete value.zoomDesigns[0].modes.overview.sourceEvidence,
  value=>value.zoomDesigns[0].modes.scene3d.imageChanged=false,
  value=>value.zoomDesigns[0].modes.scene3d.retainedMapNoticeVisible=true,
  value=>delete value.zoomDesigns[0].modes.scene3d.retainedMapNoticeVisible,
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
 fallback.zoomDesigns[0].modes.scene3d={state:'error',error:'Terrain could not prepare',visualReviewRequired:true};
 assert.equal(assertBrowserReport(fallback,commit),fallback,'A recorded external-source fallback must stay explicit, without becoming a false rendering PASS');
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
