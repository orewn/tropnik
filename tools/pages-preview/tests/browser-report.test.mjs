import test from 'node:test';
import assert from 'node:assert/strict';
import {assertBrowserReport} from '../browser-report.mjs';

const commit='a'.repeat(40);
function evidence(){
 return{verified:true,sourceCommit:commit,mapInteractionSchemaVersion:1,
  profiles:['compact-android','iphone-portrait','android-portrait','phone-landscape'].map(name=>({name,engine:'leaflet',interactionTested:true,sheetTested:true,sheetHeightDelta:0,layoutShift:0,longestTaskMs:100})),
  desktopProfiles:[{name:'desktop-webgl',engine:'maplibre',coarse:false,mapInteractionTested:true}],
  mapInteractions:[['android-portrait','leaflet',true],['desktop-webgl','maplibre',false]].map(([profile,engine,mobile])=>({profile,engine,mobile,passed:true,firstDirection:[{selected:'altai'}],secondDirection:[{selected:'baikal'}],route:{id:'route',offsetPx:14},line:{route:'route',clicked:true,selectionRetained:true,reopened:mobile},returnedToRegion:true,returnedToDirections:true,countryCameraRestored:true,polygon:{id:'territory'},gestures:{zoomInput:mobile?'touch-control':'mouse-wheel',beforeZoom:5,afterZoom:6,dragged:true,selectionPreserved:true,resizedTo:{width:900,height:412},postResizePolygon:'territory'},longestTaskMs:100}))};
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
  value=>value.mapInteractions[0].gestures.dragged=false,
  value=>delete value.mapInteractions[0].gestures.postResizePolygon,
 ];
 for(const change of changes){const bad=evidence();change(bad);assert.throws(()=>assertBrowserReport(bad,commit));}
});
