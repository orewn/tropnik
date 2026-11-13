import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installDirectDragTrace} from '../browser-smoothness.mjs';
import {smoothnessWindowFixture} from './smoothness-fixture.mjs';

function surface(){
 let now=100,listener,disconnects=0,reads=0;
 const tile=key=>({key}),map={drawRevision:1,labelRevision:1,camera:{center:[86,50],zoom:7,bearingDegrees:0},
  state:{ready:true,loading:false,mode:'detail',committedMode:'detail',error:''},coverage:{revision:1,pending:0,ready:true,error:''},
  catalogueOverlay:{currentViewportReady:true,pending:false,error:''},
  tiles:{overview:[tile('overview:4/11/5')],detail:[tile('vector:7/94/43')],relief:[tile('relief:7/94/43')],imagery:[]},loadingGround:null};
 let text=JSON.stringify(map);const dataset={mapMoving:'false'},marks=[];
 Object.defineProperty(dataset,'mapInspection',{get(){reads++;return text;},set(){assert.fail('Observer wrote application inspection');}});
 const element={isConnected:true,dataset,hasAttribute:()=>false,querySelector:selector=>{assert.equal(selector,'canvas.tropnik-map-canvas');return{width:1041,height:928};}};
 const target={document:{visibilityState:'visible',querySelector:selector=>{assert.equal(selector,'.atlas-canvas[data-map-engine]');return element;}},
  performance:{timeOrigin:100000,now:()=>now+=.1,mark(name){const value={name,startTime:now+=.1};marks.push(value);return value;}},
  MutationObserver:class{constructor(callback){listener=callback;}observe(node,options){assert.equal(node,element);assert.deepEqual(options,{attributes:true,attributeFilter:['data-map-inspection']});}disconnect(){disconnects++;}},
  requestAnimationFrame(){assert.fail('Inspection installed an animation loop');},fetch(){assert.fail('Inspection fetched a resource');}};
 return{target,map,element,marks,tile,publish(count=1){text=JSON.stringify(map);listener(Array.from({length:count},()=>({attributeName:'data-map-inspection'})));},stats:()=>({reads,disconnects})};
}

test('observer reads the actual published shape and canvas without calling application code',()=>{
 const s=surface(),installed=installDirectDragTrace(s.target,'map-pan');assert.equal(installed.installed,true);
 s.map.drawRevision=2;s.map.state.loading=true;
 s.map.loadingGround={generation:8,readyCells:2,requestedCells:42,detail:[s.tile('vector:7/94/43'),s.tile('vector:7/95/43')],relief:[s.tile('relief:7/94/43'),s.tile('relief:7/95/43')]};s.publish();
 const api=s.target.__tropnikDirectDragTrace,report=api.stop();
 assert.equal(report.readOnly,true);assert.deepEqual(report.errors,[]);assert.equal(report.disconnected,true);assert.equal(s.target.__tropnikDirectDragTrace,undefined);
 assert.deepEqual(report.transitions.map(r=>r.drawRevision),[1,2,2]);assert.equal(report.canonicalKeySets.length,1);
 assert.deepEqual(report.boundarySnapshots.map(value=>value.phase),['before','after']);
 assert.deepEqual(report.boundarySnapshots[0].inspection.camera,s.map.camera);
 assert.equal(report.boundarySnapshots[0].inspection.loadingGround,null);
 assert.deepEqual(report.boundarySnapshots[1].inspection.loadingGround,s.map.loadingGround);
 assert.deepEqual(report.boundarySnapshots[0].inspection.tiles.detail,[s.tile('vector:7/94/43')]);
 const transition=report.transitions[1];assert.equal(transition.loading.readyCells,2);assert.equal(transition.loading.generation,8);assert.equal(transition.loading.detailKeysAlsoCanonical,1);assert.equal(transition.loading.reliefKeysAlsoCanonical,1);assert.deepEqual(transition.canvas,{width:1041,height:928});
 assert.ok(report.readDurationTotalMs>0);assert.ok(report.readDurationMaxMs>0);assert.ok(report.transitions.every(r=>r.callbackStartedAtMs<=r.mark.startTimeMs));
 assert.deepEqual(report.transitions.map(r=>r.mark),s.marks.map(({name,startTime})=>({name,startTimeMs:startTime})));assert.deepEqual(report.transitions.map(r=>r.phase),['before','mutation','after']);
 assert.equal(api.stop(),report);s.map.drawRevision=3;s.publish();assert.equal(report.transitions.length,3,'Late delivery after disconnect must not append');
});

test('duplicate snapshots, coalescing and missed draw revisions remain explicit',()=>{
 const s=surface();installDirectDragTrace(s.target,'map-zoom');s.publish();
 s.map.drawRevision=5;s.publish(4);const report=s.target.__tropnikDirectDragTrace.stop();
 assert.equal(report.identicalValuesSkipped,1);assert.equal(report.callbacks,2);assert.equal(report.mutationRecords,5);assert.equal(report.coalescedMutationRecords,3);
 assert.equal(report.drawRevisionGaps,3);assert.equal(report.maxDrawRevisionDelta,4);assert.equal(report.transitions[1].drawDelta,4);assert.equal(report.transitions.length,3);
});

test('transition and canonical-key bounds stop evidence growth and preserve cleanup',()=>{
 for(const kind of ['transitions','keySets']){
  const s=surface(),installed=installDirectDragTrace(s.target,'map-pan'),api=s.target.__tropnikDirectDragTrace;
  const count=kind==='transitions'?installed.limits.transitions+3:installed.limits.keySets+3;
  for(let i=0;i<count;i++){s.map.drawRevision++;if(kind==='keySets')s.map.tiles.detail=[s.tile('vector:7/'+i+'/43')];s.publish();}
  const report=api.stop();assert.equal(report.overflow,true);assert.ok(report.transitions.length<=installed.limits.transitions);assert.ok(report.canonicalKeySets.length<=installed.limits.keySets);assert.ok(s.stats().disconnects>0);assert.equal(report.disconnected,true);assert.equal(s.target.__tropnikDirectDragTrace,undefined);
 }
});

test('malformed published state is diagnostic error without an application mutation',()=>{
 const s=surface();installDirectDragTrace(s.target,'map-pan');s.map.tiles.detail=Array.from({length:65},(_,i)=>s.tile('vector:'+i));s.publish();
 s.element.isConnected=false;s.publish();const report=s.target.__tropnikDirectDragTrace.stop();
 assert.ok(report.errors.some(message=>message.includes('tile list')));assert.ok(report.errors.some(message=>message.includes('replaced')));assert.equal(report.disconnected,true);assert.equal(s.target.__tropnikDirectDragTrace,undefined);
});

test('opt-in desktop pan-only trace keeps one action and raw windows; error/cap paths still drain after the window',async t=>{
 const prior=process.env.TROPNIK_DIRECT_DRAG_TRACE;process.env.TROPNIK_DIRECT_DRAG_TRACE='1';
 let diagnostic;try{diagnostic=await import('../browser-smoothness.mjs?direct-drag-test');}finally{if(prior===undefined)delete process.env.TROPNIK_DIRECT_DRAG_TRACE;else process.env.TROPNIK_DIRECT_DRAG_TRACE=prior;}
 assert.deepEqual(diagnostic.SMOOTHNESS_TRACE_SCENARIOS,['map-pan']);assert.equal(diagnostic.SMOOTHNESS_LIMITS.frameP95Ms,35);
 for(const [profile,name]of [['android-portrait','map-pan'],['desktop-webgl','panel'],['desktop-webgl','map-zoom']]){
  const report={profile,scenarios:[],traces:[]};let actions=0;
  await diagnostic.measureSmoothnessWindow({call:()=>assert.fail('Unselected trace'),observe:()=>assert.fail('Unselected trace observer')},name,async()=>{actions++;},{report,tracing:true,evaluate:async(cdp,expression)=>expression.includes('__tropnikSmoothness.stop(')?smoothnessWindowFixture(name).raw:undefined});
  assert.equal(actions,1);assert.equal(report.directDragTrace,undefined);assert.deepEqual(report.traces,[]);
 }
 const directory=await mkdtemp(join(tmpdir(),'tropnik-direct-drag-trace-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const mode of ['pan','action-error','stop-error','cap']){
  const name='map-pan',expectedCap=8000,report={profile:'desktop-webgl',scenarios:[],traces:[]},order=[],timers=new Map(),failure=new Error(mode);let active=false,actions=0,completion,now=0,nextTimer=0,stopped=0;
  const cdp={observe(event,listener){assert.equal(event,'Tracing.tracingComplete');completion=listener;return()=>{completion=null;};},async call(method){order.push(method);if(method==='Tracing.start'||method.startsWith('IO.'))assert.equal(active,false);if(method==='Tracing.end')completion({stream:'trace',dataLossOccurred:false});if(method==='IO.read')return{data:JSON.stringify({traceEvents:[{name:'RunTask',cat:'cc'}]}),eof:true};return{};}};
  const evaluate=async(cdp,expression)=>{
   if(expression.includes('navigator.serviceWorker')){assert.equal(active,false);order.push('worker');return{readOnly:true};}
   if(expression.startsWith('(function installDirectDragTrace')){assert.equal(active,false);order.push('observer-install');return{installed:true};}
   if(expression.includes('performance.mark(')){assert.equal(active,false);order.push('clock');return{name:'clock',startTimeMs:now,timeOriginMs:0};}
   if(expression.includes('__tropnikDirectDragTrace?.stop()')){stopped++;order.push('observer-stop');return{disconnected:true,transitions:[]};}
   if(expression.includes('__tropnikSmoothness.start(')){assert.equal(active,false);active=true;order.push('window-start');return 100;}
   if(expression.includes('__tropnikSmoothness.stop(')){active=false;order.push('window-stop');if(mode==='stop-error')throw failure;return smoothnessWindowFixture(name).raw;}
   assert.ok(expression.includes('requestAnimationFrame'));order.push('final-frames');
  };
  const traceOptions={output:pathToFileURL(directory+'/'),clock:()=>now,schedule:(callback,ms)=>{const id=++nextTimer;timers.set(id,{callback,ms});return id;},cancel:id=>timers.delete(id)};
  const operation=diagnostic.measureSmoothnessWindow(cdp,name,async()=>{
   actions++;assert.equal(active,true);order.push('native-action');if(mode==='action-error')throw failure;
   if(mode==='cap'){now=expectedCap;[...timers.values()].find(timer=>timer.ms===expectedCap).callback();await new Promise(resolve=>setImmediate(resolve));assert.equal(order.some(value=>value.startsWith('IO.')),false);now+=6000;}
  },{evaluate,report,tracing:true,sourceCommit:'b'.repeat(40),traceOptions});
  if(mode.endsWith('error'))await assert.rejects(operation,error=>error===failure);else await operation;
  assert.equal(actions,1);assert.equal(stopped,1);assert.equal(active,false);assert.equal(completion,null);assert.equal(timers.size,0);assert.ok(order.indexOf('Tracing.start')<order.indexOf('window-start'));assert.ok(order.indexOf('IO.read')>order.indexOf('window-stop'));
  assert.equal(report.directDragTrace[0].diagnosticOnly,true);assert.equal(report.directDragTrace[0].inspection.disconnected,true);assert.deepEqual(report.directDragTrace[0].errors,[]);
  assert.equal(report.traces[0].limits.durationMs,expectedCap);assert.equal(report.traces[0].status,mode==='cap'?'partial':'complete');assert.equal(report.scenarios.length,mode==='stop-error'?0:1);if(report.scenarios.length)assert.deepEqual(report.scenarios[0],smoothnessWindowFixture(name));
 }
});
