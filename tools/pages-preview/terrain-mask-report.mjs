import assert from 'node:assert/strict';
import {assertBrowserEnvironment,assertMatchingBrowserEnvironments} from './browser-environment.mjs';
import {assertNativeSurfaceCoverage} from './browser-native-surface.mjs';

function assertPixels(metrics){
 assert.equal(metrics?.width,512);assert.equal(metrics?.height,384);
 for(const key of ['outsideWitnesses','insideWitnesses','nearBoundaryOutside','terrainLeaks','routeLeaks','nearBoundaryRouteLeaks','insideVisible','routeCorePixels','routeHaloPixels'])assert.ok(Number.isInteger(metrics[key])&&metrics[key]>=0,`Missing mask pixel measurement: ${key}`);
 assert.ok(metrics.outsideWitnesses>=256&&metrics.insideWitnesses>=256&&metrics.nearBoundaryOutside>=24,'Insufficient independent pixel witnesses');
 assert.equal(metrics.terrainLeaks,0);assert.equal(metrics.routeLeaks,0);assert.equal(metrics.nearBoundaryRouteLeaks,0);
 assert.equal(metrics.insideVisibleRatio,metrics.insideVisible/Math.max(1,metrics.insideWitnesses));
 assert.ok(metrics.insideVisibleRatio>=.95&&metrics.insideVisibleRatio<=1,'Allowed terrain was missing');
 assert.ok(metrics.routeCorePixels>=24&&metrics.routeHaloPixels>=12,'The thick route was not rendered');
}
export function assertTerrainMaskReport(mask,{sourceCommit,environment,rendererSHA256}={}){
 assert.equal(mask?.schemaVersion,1);assert.equal(mask?.verified,true,'The real terrain pixel gate did not pass');
 assert.equal(mask.phase,'complete');assert.equal(mask.evidence,'production-renderer-browser-pixels');
 assert.equal(mask.sourceCommit,sourceCommit);assert.match(mask.rendererSHA256||'',/^[a-f0-9]{64}$/);
 if(rendererSHA256!==undefined)assert.equal(mask.rendererSHA256,rendererSHA256,'Pixel proof used another production renderer');
 assertBrowserEnvironment(mask.environment,sourceCommit);
 assertNativeSurfaceCoverage(mask.environment.nativeSurface,[{name:'terrain-mask',width:512,height:384,deviceScaleFactor:1}]);
 if(environment)assertMatchingBrowserEnvironments(mask.environment,environment,sourceCommit);
 assert.equal(mask.cases?.length,4,'All four real renderer cases are required');
 for(const renderer of ['webgl2','canvas2d'])for(const changedView of [false,true]){
  const name=`${renderer}-${changedView?'rotated-zoomed':'initial'}`,matches=mask.cases.filter(item=>item.name===name);
  assert.equal(matches.length,1,`Missing unique real pixel case: ${name}`);const item=matches[0];
  assert.equal(item.verified,true);assert.equal(item.phase,'complete');assert.equal(item.renderer,renderer,'Canvas fallback cannot replace required WebGL2');
  assert.equal(item.callerMaskMutationChecked,true);assert.deepEqual(item.view,{rotate:changedView?.61:0,zoom:changedView?1.3:1});assertPixels(item.metrics);
  const restores=renderer==='webgl2'&&changedView,phases=['reference','empty','first-masked-frame','masked-route',...(restores?['context-restored']:[])];
  assert.equal(item.frames?.length,phases.length);
  for(const phase of phases){
   const frames=item.frames.filter(frame=>frame.phase===phase);assert.equal(frames.length,1,`Missing real ${name} ${phase} capture`);const frame=frames[0];
   assert.equal(frame.renderer,renderer,'A fallback surface cannot stand in for a WebGL capture');assert.equal(frame.width,512);assert.equal(frame.height,384);
   assert.equal(frame.file,`${name}-${phase}.png`);assert.ok(Number.isInteger(frame.bytes)&&frame.bytes>=33&&frame.bytes<=8*1024*1024);assert.match(frame.sha256||'',/^[a-f0-9]{64}$/);
  }
  if(restores){assert.equal(item.recovery?.lost,1);assert.equal(item.recovery?.restored,1);assert.equal(item.recovery?.trusted,true);assertPixels(item.recovery.metrics);}
  else assert.equal(item.recovery,null);
 }
 return mask;
}
