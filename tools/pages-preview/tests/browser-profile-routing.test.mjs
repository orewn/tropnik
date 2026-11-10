import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {browserTraceEnabled} from '../browser-trace.mjs';

// Execute the actual profile dispatch loop with audit boundaries substituted.
// This checks option forwarding and invocation counts, not browser rendering.
const source=await readFile(new URL('../browser-smoke.mjs',import.meta.url),'utf8');
const start=source.indexOf('  for(const profile of profiles.filter(');
const end=source.indexOf('\n  if(!runPolicy.diagnostic){',start);
assert.ok(start>=0&&end>start,'The production profile loop must be available');
const dispatch=source.slice(start,end);
const AsyncFunction=(async()=>{}).constructor;
const profiles=[
 {name:'desktop-webgl',width:1280,height:800,engine:'maplibre',mobile:false,mapInteraction:true},
 {name:'android-portrait',width:412,height:915,engine:'leaflet',mobile:true,mapInteraction:true},
 {name:'compact-android',width:320,height:640,engine:'leaflet',mobile:true,mapInteraction:false},
];

async function dispatchProfiles(traceEnabled,audit,{diagnostic=null,overrides={}}={}){
 const unavailable=async()=>({available:false});
 const notInvoked=()=>assert.fail('The routing test must not invoke browser helpers');
 const bindings={
  assert,profiles,runPolicy:{diagnostic,profiles:diagnostic?['desktop-webgl']:null,reportFile:diagnostic?'browser-terrain-diagnostic.json':'browser-verification.json'},traceEnabled,cdp:{},httpPort:4200,
  results:[],desktopProfiles:[],mapInteractions:[],zoomDesigns:[],profilePerformance:[],performanceIssues:[],
  runZoomDesignAudit:audit,
  loadProfile:async(_cdp,_url,profile)=>({engine:profile.engine,width:profile.width,scrollWidth:profile.width,escaping:[],undersized:[]}),
  evaluate:async()=>false,mapInteraction:async(_cdp,profile)=>({profile:profile.name,passed:true}),
  performanceDiagnostics:async()=>({}),checkpoint:async()=>{},diagnosticPhase:async()=>{},
  touchSheet:unavailable,touchSheetGestures:async()=>({}),checkMapGeometry:async()=>({}),touchPrevious:unavailable,
  waitValue:notInvoked,sleep:notInvoked,settledMap:notInvoked,closeMapSheet:notInvoked,clearMapStories:notInvoked,
  elementPoint:notInvoked,pointerAt:notInvoked,pointerSelector:notInvoked,mapState:notInvoked,
 };
 Object.assign(bindings,overrides);
 await new AsyncFunction(...Object.keys(bindings),`let currentProfile,browserSystemCdp;\n${dispatch}`)(...Object.values(bindings));
 return bindings;
}

for(const [label,flag] of [['default',undefined],['explicit opt-in','1']]){
 test(`the ${label} full matrix forwards tracing to desktop and mobile zoom audits exactly once`,async()=>{
  const traceEnabled=browserTraceEnabled(flag),calls=[];
  const result=await dispatchProfiles(traceEnabled,async(_cdp,profile,helpers,options)=>{
   calls.push({name:profile.name,options});
   assert.equal(helpers.url,'http://127.0.0.1:4200/tropnik/');
   return{profile:profile.name};
  });
  assert.deepEqual(calls,[
   {name:'desktop-webgl',options:{traceEnabled}},
   {name:'android-portrait',options:{traceEnabled}},
  ]);
  assert.deepEqual(result.zoomDesigns.map(item=>item.profile),['desktop-webgl','android-portrait']);
  assert.deepEqual(result.results.map(item=>item.name),['android-portrait','compact-android']);
 });
}

test('a desktop audit failure propagates unchanged without repeating or continuing the matrix',async()=>{
 const failure=new Error('The maplibre map did not settle'),calls=[];
 const observed=await dispatchProfiles(true,async(_cdp,profile)=>{calls.push(profile.name);throw failure;}).then(()=>null,error=>error);
 assert.equal(observed,failure);assert.deepEqual(calls,['desktop-webgl']);
});

test('diagnostic GPU and process queries reuse only the advertised browser target',async()=>{
 const requests=[],calls=[],writes=[];let opens=0,connections=0;
 class BrowserCDP{
  constructor(url){assert.equal(url,'ws://browser-target');connections++;}
  async open(){opens++;}
  async call(method,params,timeout){assert.deepEqual(params,{});assert.equal(timeout,3000);calls.push(method);return method==='SystemInfo.getInfo'?{gpu:{devices:[]}}:{processInfo:[{id:1,type:'browser',cpuTime:10}]};}
 }
 const result=await dispatchProfiles(true,async(_cdp,profile,helpers,options)=>{
  assert.equal(profile.name,'desktop-webgl');assert.deepEqual(options,{diagnostic:'terrain-close'});
  assert.deepEqual(await helpers.systemInfo(),{gpu:{devices:[]}});
  for(let count=0;count<2;count++)assert.deepEqual(await helpers.systemProcessInfo(),{processInfo:[{id:1,type:'browser',cpuTime:10}]});
  return{diagnosticOnly:true,verified:false,releaseEligible:false};
 },{diagnostic:'terrain-close',overrides:{CDP:BrowserCDP,debugPort:4300,browser:{async requestJSON(url){requests.push(url);return{webSocketDebuggerUrl:'ws://browser-target'};}},REPORT:'diagnostic-output',writeFile:async(...args)=>writes.push(args),console:{log(){}}}});
 assert.deepEqual(requests,['http://127.0.0.1:4300/json/version']);assert.equal(connections,1);assert.equal(opens,1);
 assert.deepEqual(calls,['SystemInfo.getInfo','SystemInfo.getProcessInfo','SystemInfo.getProcessInfo']);assert.equal(writes.length,1);assert.equal(result.results.length,0);
});
