import test from 'node:test';
import assert from 'node:assert/strict';
import {requestLabelInspection,COAST_LABEL_REQUEST,assertCoastLabelInspection} from '../browser-label-audit.mjs';
import {assertCoastAudit} from '../browser-coast-audit.mjs';
import {coastFixture} from './coast-fixture.mjs';
import {customMapFixture} from './custom-map-fixture.mjs';

test('the coastline inspector queries retained frame decisions beyond the unrelated general DOM sample',()=>{
 const map=customMapFixture(),selectors=[],events=[];
 map.labels=Array.from({length:512},(_,i)=>({label:`Other ${i}`,coordinate:[28.6,60.36],visible:false,reason:'collision'}));
 const matches=[{label:'Приморск',coordinate:[28.6,60.36],visible:true,reason:'drawn',width:50,rect:{left:10,right:60,top:10,bottom:25}}];
 const canvas={isConnected:true,width:1000,height:700,getBoundingClientRect:()=>({width:1000,height:700})};
 const container={dataset:{mapInspection:JSON.stringify(map)},querySelector:selector=>{assert.equal(selector,'canvas.tropnik-map-canvas');return canvas;},dispatchEvent(event){
  events.push(event.type);assert.deepEqual(event.detail.request,COAST_LABEL_REQUEST);
  event.detail.response=JSON.stringify({...map,labels:matches,labelInspection:{...COAST_LABEL_REQUEST,totalCandidates:600,retainedCandidates:600,matchingCandidates:1,truncated:false}});
 }};
 const doc={querySelector:selector=>{selectors.push(selector);return container;}};
 const result=requestLabelInspection(COAST_LABEL_REQUEST,doc);
 assert.equal(result.snapshot.engine,'tropnik-canvas');assert.deepEqual(result.snapshot.candidates,matches);assert.deepEqual(result.snapshot.before,result.snapshot.after);assert.equal(result.snapshot.customMap.canvas.connected,true);assert.ok(result.durationMs>=0);
 assert.equal(result.snapshot.truncated,false);assert.equal(result.snapshot.customMap.labelInspection.retainedCandidates,600);
 assert.deepEqual(events,['tropnik-map-label-inspection']);assert.equal(container.dataset.mapInspection,JSON.stringify(map));
 assert.deepEqual(result.snapshot.revisions,{before:{drawRevision:2,labelRevision:2},queried:{drawRevision:2,labelRevision:2},after:{drawRevision:2,labelRevision:2}});
 assert.deepEqual(selectors,['.atlas-canvas[data-map-engine="tropnik-canvas"]']);
 container.dataset.mapInspection='{bad';assert.equal(requestLabelInspection(COAST_LABEL_REQUEST,doc).snapshot,null);
 assert.equal(requestLabelInspection(COAST_LABEL_REQUEST,{querySelector:()=>null}).error,'Custom map DOM container is missing');
});

test('a missing, oversized or invalid named response cannot masquerade as complete diagnostics',()=>{
 const map=customMapFixture();
 for(const response of [undefined,'x'.repeat(1000001),'{bad',JSON.stringify({error:'Invalid label inspection request'}),JSON.stringify(map)]){
  const container={dataset:{mapInspection:JSON.stringify(map)},dispatchEvent(event){event.detail.response=response;}};
  assert.equal(requestLabelInspection(COAST_LABEL_REQUEST,{querySelector:()=>container}).snapshot,null);
 }
});

test('coastline acceptance requires five lossless custom label captures attached to the unchanged screenshots',()=>{
 for(const profile of ['android-portrait','desktop-webgl'])assert.ok(assertCoastAudit(coastFixture(profile,'tropnik-canvas'),profile,'tropnik-canvas'));
 const profile='desktop-webgl',valid=coastFixture(profile,'tropnik-canvas'),frame=valid.steps[0],shot=valid.screenshots[0],capture=valid.labelDiagnostics[0];
 assert.equal(assertCoastLabelInspection(capture,frame,shot),capture);
 for(const mutate of [
  value=>value.labelDiagnostics.pop(),
  value=>value.schemaVersion=1,
  value=>value.labelDiagnostics[0].afterScreenshot=false,
  value=>value.labelDiagnostics[0].snapshot.cameraPreserved=false,
  value=>value.labelDiagnostics[0].snapshot.after.zoom++,
  value=>{value.labelDiagnostics[0].snapshot.before.longitude++;value.labelDiagnostics[0].snapshot.after.longitude++;},
  value=>value.labelDiagnostics[0].screenshotSha256='f'.repeat(64),
  value=>value.labelDiagnostics[0].snapshot=null,
  value=>value.labelDiagnostics[0].snapshot.truncated=true,
  value=>value.labelDiagnostics[0].snapshot.customMap.labelInspection.truncated=true,
  value=>value.labelDiagnostics[0].snapshot.customMap.labelInspection.totalCandidates=6401,
  value=>value.labelDiagnostics[0].snapshot.customMap.labelInspection.retainedCandidates=1,
  value=>value.labelDiagnostics[0].snapshot.customMap.labelInspection.matchingCandidates=1,
  value=>value.labelDiagnostics[0].snapshot.customMap.labelInspection.names=['Other'],
  value=>value.labelDiagnostics[0].snapshot.customMap.labelInspection.limit=101,
  value=>value.labelDiagnostics[0].snapshot.revisions.queried.drawRevision++,
  value=>value.labelDiagnostics[0].snapshot.revisions.after.labelRevision++,
  value=>value.labelDiagnostics[0].snapshot.customMap.camera.zoom++,
  value=>value.labelDiagnostics[0].snapshot.customMap.state.committedMode='overview',
  value=>value.labelDiagnostics[0].snapshot.readOnly=false,
  value=>value.labelDiagnostics[0].snapshot.error='read failed',
  value=>value.labelDiagnostics[0].snapshot.candidates.push({label:'Приморск'}),
 ]){const changed=structuredClone(valid);mutate(changed);assert.throws(()=>assertCoastAudit(changed,profile,'tropnik-canvas'));}
});
