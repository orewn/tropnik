import test from 'node:test';
import assert from 'node:assert/strict';
import {requestLabelInspection,COAST_LABEL_REQUEST,assertCoastLabelInspection} from '../browser-label-audit.mjs';
import {assertCoastAudit} from '../browser-coast-audit.mjs';
import {MAP_LABEL_DIAGNOSTIC_EVENT} from '../../../web/public/maps/map-label-coverage.js';
import {coastFixture} from './coast-fixture.mjs';

test('the coastline harness requests explicit read-only DOM evidence and reports a missing listener honestly',()=>{
 const container=new EventTarget(),selectors=[];
 const doc={querySelector(selector){selectors.push(selector);return container;}};
 assert.equal(requestLabelInspection(COAST_LABEL_REQUEST,doc).snapshot,null);
 const listener=event=>{assert.deepEqual(event.detail.request,COAST_LABEL_REQUEST);event.detail.result={fixture:'read-only'};};
 container.addEventListener(MAP_LABEL_DIAGNOSTIC_EVENT,listener);
 const result=requestLabelInspection(COAST_LABEL_REQUEST,doc);
 assert.deepEqual(result.snapshot,{fixture:'read-only'});assert.ok(result.durationMs>=0);
 assert.deepEqual(selectors,['.atlas-canvas[data-map-engine="maplibre"]','.atlas-canvas[data-map-engine="maplibre"]']);
 container.removeEventListener(MAP_LABEL_DIAGNOSTIC_EVENT,listener);
 assert.equal(requestLabelInspection(COAST_LABEL_REQUEST,{querySelector:()=>null}).error,'MapLibre DOM container is missing');
});

test('coastline acceptance requires all five lossless label captures attached to their unchanged screenshots',()=>{
 for(const engine of ['leaflet','maplibre'])assert.ok(assertCoastAudit(coastFixture('fixture',engine),'fixture',engine));
 const valid=coastFixture('fixture','maplibre'),frame=valid.steps[0],shot=valid.screenshots[0],capture=valid.labelDiagnostics[0];
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
  value=>value.labelDiagnostics[0].snapshot.sources[0].truncated=true,
  value=>value.labelDiagnostics[0].snapshot.sources[0].source='another-source',
  value=>value.labelDiagnostics[0].snapshot.readOnly=false,
  value=>value.labelDiagnostics[0].snapshot.error='query failed',
 ]){const changed=structuredClone(valid);mutate(changed);assert.throws(()=>assertCoastAudit(changed,'fixture','maplibre'));}
});
