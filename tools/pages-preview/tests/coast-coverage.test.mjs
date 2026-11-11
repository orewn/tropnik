import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {inspectCoastCoverage,assertCoastAudit} from '../browser-coast-audit.mjs';
import {inspectCustomMapDOM} from '../browser-custom-map.mjs';
import {customMapFixture} from './custom-map-fixture.mjs';
import {coastFixture} from './coast-fixture.mjs';

function observedPrimorsk(){
 const map=customMapFixture({camera:{longitude:28.606951677419374,latitude:60.362384700191264,zoom:7.621307459879889},routeId:''});
 // Exact geographic receipt in the failed 16f731 browser run. Legacy flags
 // were absent while this actual inspection was already ready and painted.
 map.drawRevision=52;
 map.coverage={version:'e0ce67282bfd3694',lod:'regional',cells:['0109-310','0109-311','0109-312','0109-3130','0109-3131','0109-31320','0109-31321','0109-31322','0109-31323','0109-3133','0109-33','0209-20','0209-22'],pending:0,error:'',ready:true,revision:4};
 return map;
}

function dom(value){
 const canvas={isConnected:true,width:412,height:847,getBoundingClientRect:()=>({width:412,height:847})};
 const element={dataset:{mapInspection:JSON.stringify(value)},querySelector:selector=>{assert.equal(selector,'canvas.tropnik-map-canvas');return canvas;},dispatchEvent(){assert.fail('Coverage inspection cannot dispatch application input');}};
 const document={querySelector:selector=>{assert.equal(selector,'.atlas-canvas[data-map-engine="tropnik-canvas"]');return element;}};
 const read=()=>runInNewContext(`(${inspectCoastCoverage.toString()})((${inspectCustomMapDOM.toString()})())`,{document});
 return{element,read};
}

test('the observed Primorsk coverage is read from actual custom renderer DOM without removed SDK flags',()=>{
 const map=observedPrimorsk(),{read,element}=dom(map),result=read();
 assert.equal(element.dataset.mapCoverageReady,undefined);
 assert.equal(result.ready,true);assert.equal(result.pending,0);assert.equal(result.error,'');
 assert.equal(result.version,'e0ce67282bfd3694');assert.equal(result.lod,'regional');assert.equal(result.revision,4);
 assert.deepEqual([...result.cells],map.coverage.cells);assert.equal(result.bitmapInspection.drawRevision,52);
 assert.equal(result.bitmapInspection.canvas.connected,true);assert.equal(result.bitmapInspection.readOnly,true);
 assert.equal(element.dataset.mapInspection,JSON.stringify(map),'Reading must leave the application diagnostic unchanged');
});

test('legacy success flags cannot hide pending, failed or missing real coverage',()=>{
 for(const coverage of [{...observedPrimorsk().coverage,ready:false,pending:2},{...observedPrimorsk().coverage,ready:false,error:'coverage-integrity'},{...observedPrimorsk().coverage,pending:undefined},{...observedPrimorsk().coverage,error:undefined}]){
  const map=observedPrimorsk();map.coverage=coverage;const {read,element}=dom(map);
  Object.assign(element.dataset,{mapCoverageReady:'true',mapCoveragePending:'0',mapCoverageError:'',mapCoverageVersion:'a'.repeat(16),mapCoverageLod:'source',mapCoverageCells:'invented'});
  const state=read();assert.equal(state?.ready===true&&state.pending===0&&state.error==='',false);
 }
 const {read,element}=dom(observedPrimorsk());
 for(const raw of ['', '{bad', 'x'.repeat(1000001), JSON.stringify({...observedPrimorsk(),coverage:undefined})]){
  element.dataset.mapInspection=raw;assert.equal(read(),null);
 }
 assert.equal(inspectCoastCoverage(null),null);
});

test('coastline summaries require the same real geographic receipt, canvas and camera at every scale',()=>{
 for(const profile of ['android-portrait','desktop-webgl']){
  const good=coastFixture(profile,'tropnik-canvas');assert.equal(assertCoastAudit(good,profile,'tropnik-canvas'),good);
  for(const mutate of [
   frame=>delete frame.bitmapInspection,
   frame=>frame.bitmapInspection.coverage.pending=1,
   frame=>frame.bitmapInspection.coverage.error='coverage-integrity',
   frame=>frame.bitmapInspection.coverage.version='f'.repeat(16),
   frame=>frame.bitmapInspection.coverage.lod='overview',
   frame=>frame.bitmapInspection.coverage.cells=['another-cell'],
   frame=>frame.bitmapInspection.coverage.revision++,
   frame=>{frame.revision=-1;frame.bitmapInspection.coverage.revision=-1;},
   frame=>frame.bitmapInspection.canvas.connected=false,
   frame=>frame.bitmapInspection.drawRevision=0,
   frame=>frame.bitmapInspection.camera.center[0]+=.1,
   frame=>frame.bitmapInspection.camera.zoom++,
   frame=>frame.camera.zoom++,
   frame=>frame.bitmapInspection.state.committedMode='overview',
  ]){
   const invalid=structuredClone(good);mutate(invalid.steps[0]);assert.throws(()=>assertCoastAudit(invalid,profile,'tropnik-canvas'));
  }
  for(const mutate of [
   frame=>{frame.lod='local';frame.bitmapInspection.coverage.lod='local';},
   frame=>{frame.cells=[];frame.bitmapInspection.coverage.cells=[];},
   frame=>{frame.centerErrorPx=6.1;},
  ]){const invalid=structuredClone(good);mutate(invalid.steps.find(frame=>frame.targetZoom===18));assert.throws(()=>assertCoastAudit(invalid,profile,'tropnik-canvas'));}
 }
});
