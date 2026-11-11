import test from 'node:test';
import assert from 'node:assert/strict';
import {requestLabelInspection,COAST_LABEL_REQUEST,assertCoastLabelInspection} from '../browser-label-audit.mjs';
import {assertCoastAudit} from '../browser-coast-audit.mjs';
import {coastFixture} from './coast-fixture.mjs';
import {customMapFixture} from './custom-map-fixture.mjs';

test('the coastline inspector reads actual bounded custom-map DOM without dispatching an application event',()=>{
 const map=customMapFixture(),selectors=[];
 map.labels=[{label:'Приморск',coordinate:[28.6,60.36],visible:true,reason:'drawn',width:50,rect:{left:10,right:60,top:10,bottom:25}}];
 const canvas={isConnected:true,width:1000,height:700,getBoundingClientRect:()=>({width:1000,height:700})};
 const container={dataset:{mapInspection:JSON.stringify(map)},querySelector:selector=>{assert.equal(selector,'canvas.tropnik-map-canvas');return canvas;},dispatchEvent(){assert.fail('The inspector must never call an application method');}};
 const doc={querySelector:selector=>{selectors.push(selector);return container;}};
 const result=requestLabelInspection(COAST_LABEL_REQUEST,doc);
 assert.equal(result.snapshot.engine,'tropnik-canvas');assert.deepEqual(result.snapshot.candidates,map.labels);assert.deepEqual(result.snapshot.before,result.snapshot.after);assert.equal(result.snapshot.customMap.canvas.connected,true);assert.ok(result.durationMs>=0);
 assert.deepEqual(selectors,['.atlas-canvas[data-map-engine="tropnik-canvas"]']);
 container.dataset.mapInspection='{bad';assert.equal(requestLabelInspection(COAST_LABEL_REQUEST,doc).snapshot,null);
 assert.equal(requestLabelInspection(COAST_LABEL_REQUEST,{querySelector:()=>null}).error,'Custom map DOM container is missing');
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
  value=>value.labelDiagnostics[0].snapshot.customMap.state.committedMode='overview',
  value=>value.labelDiagnostics[0].snapshot.readOnly=false,
  value=>value.labelDiagnostics[0].snapshot.error='read failed',
  value=>value.labelDiagnostics[0].snapshot.candidates.push({label:'Приморск'}),
 ]){const changed=structuredClone(valid);mutate(changed);assert.throws(()=>assertCoastAudit(changed,profile,'tropnik-canvas'));}
});
