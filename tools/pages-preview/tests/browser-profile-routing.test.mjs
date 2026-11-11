import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {browserTraceEnabled} from '../browser-trace.mjs';
import {browserAuditRunPolicy} from '../browser-zoom-audit.mjs';
import {assertBrowserReport} from '../browser-report.mjs';
import {satellitePerformanceIssues} from '../browser-satellite-audit.mjs';

// Execute the actual profile dispatch loop with audit boundaries substituted.
// This checks option forwarding and invocation counts, not browser rendering.
const source=await readFile(new URL('../browser-smoke.mjs',import.meta.url),'utf8');
const start=source.indexOf('  for(const profile of profiles.filter(');
const end=source.indexOf('\n}catch(error){',start);
assert.ok(start>=0&&end>start,'The production profile loop and final audit dispatch must be available');
const dispatch=source.slice(start,end);
const AsyncFunction=(async()=>{}).constructor;
const profiles=[
 {name:'desktop-webgl',width:1280,height:800,engine:'tropnik-canvas',mobile:false,mapInteraction:true},
 {name:'android-portrait',width:412,height:915,engine:'tropnik-canvas',mobile:true,mapInteraction:true},
 {name:'compact-android',width:320,height:640,engine:'tropnik-canvas',mobile:true,mapInteraction:false},
 {name:'iphone-portrait',width:390,height:844,engine:'tropnik-canvas',mobile:true,mapInteraction:false},
 {name:'phone-landscape',width:844,height:390,engine:'tropnik-canvas',mobile:true,mapInteraction:false},
];

async function dispatchProfiles(traceEnabled,audit,policy=browserAuditRunPolicy(undefined),issues=[],offlineAudit,satelliteAudit){
 const unavailable=async()=>({available:false});
 const notInvoked=()=>assert.fail('The routing test must not invoke browser helpers');
 const layerMenuCalls=[],loadCalls=[],mapCalls=[],reports=[],offlineCalls=[],satelliteCalls=[],smoothnessCalls=[],cdpCalls=[];
 const bindings={
  environment:{routingFixture:true},terrainMask:{routingFixture:true},assert,profiles,runPolicy:policy,traceEnabled,cdp:{call:async(method,parameters)=>cdpCalls.push({method,parameters})},httpPort:4200,
  results:[],desktopProfiles:[],mapInteractions:[],zoomDesigns:[],satelliteAudits:[],siteSmoothness:[],profilePerformance:[],performanceIssues:issues,catalogue:{schemaVersion:1,total:21},
  REPORT:policy.reportFile,reports,loadCalls,mapCalls,process:{env:{GITHUB_SHA:'a'.repeat(40)}},console:{log(){}},writeFile:async(path,text)=>reports.push({path,report:JSON.parse(text)}),
  runZoomDesignAudit:audit,
  smoothnessCalls,siteSmoothnessAudit:async(_cdp,profile,rate=1)=>{smoothnessCalls.push({profile:profile.name,rate});return{profile:profile.name,performanceIssues:[]};},
  satelliteCalls,satellitePerformanceIssues,runSatelliteContinuityAudit:async(cdp,profile,helpers)=>{satelliteCalls.push(profile.name);return satelliteAudit? satelliteAudit(cdp,profile,helpers):{profile:profile.name,performance:{layoutShift:0,longestTaskMs:100}};},
  server:{},offlineOriginTransport:{start:notInvoked,snapshot:notInvoked,restore:notInvoked},
  offlineCalls,cdpCalls,runOfflineSafetyAudit:async(cdp,helpers)=>{offlineCalls.push({cdp,helpers});return offlineAudit?offlineAudit(cdp,helpers):{schemaVersion:1,profile:'android-portrait',passed:true};},
  loadProfile:async(_cdp,_url,profile)=>{loadCalls.push(profile.name);return{engine:profile.engine,width:profile.width,scrollWidth:profile.width,escaping:[],undersized:[]};},
  evaluate:async()=>false,mapInteraction:async(_cdp,profile)=>{mapCalls.push(profile.name);return{profile:profile.name,passed:true};},
  performanceDiagnostics:async()=>({}),checkpoint:async()=>{},diagnosticPhase:async()=>{},
  touchSheet:unavailable,touchSheetGestures:async()=>({}),checkMapGeometry:async()=>({}),touchPrevious:unavailable,
  layerMenuCalls,checkPortraitLayerMenus:async(_cdp,profile)=>{layerMenuCalls.push(profile.name);return{profile:profile.name,passed:true};},
  waitValue:notInvoked,sleep:notInvoked,settledMap:notInvoked,closeMapSheet:notInvoked,clearMapStories:notInvoked,
  elementPoint:notInvoked,pointerAt:notInvoked,pointerSelector:notInvoked,mapState:notInvoked,
 };
 await new AsyncFunction(...Object.keys(bindings),`let currentProfile;\n${dispatch}`)(...Object.values(bindings));
 return bindings;
}

for(const [label,flag] of [['default',undefined],['explicit opt-in','1']]){
 test(`the ${label} full matrix forwards tracing to desktop and mobile zoom audits exactly once`,async()=>{
  const traceEnabled=browserTraceEnabled(flag),calls=[];
  const result=await dispatchProfiles(traceEnabled,async(_cdp,profile,helpers,options)=>{
   calls.push({name:profile.name,options});
   assert.equal(helpers.url,'http://127.0.0.1:4200/tropnik/');
   assert.equal(Array.isArray(helpers.performanceIssues),true,'The new satellite interval must feed the existing delayed performance gate');
   return{profile:profile.name};
  });
  assert.deepEqual(calls,[
   {name:'desktop-webgl',options:{traceEnabled}},
   {name:'android-portrait',options:{traceEnabled}},
  ]);
  assert.deepEqual(result.zoomDesigns.map(item=>item.profile),['desktop-webgl','android-portrait']);
  assert.deepEqual(result.results.map(item=>item.name),['android-portrait','compact-android','iphone-portrait','phone-landscape']);
  assert.deepEqual(result.layerMenuCalls,['android-portrait','compact-android','iphone-portrait'],'Layers must run once for each portrait phone, never for landscape or desktop');
  assert.deepEqual(result.results.map(item=>item.layerMenus),[
   {profile:'android-portrait',passed:true},{profile:'compact-android',passed:true},{profile:'iphone-portrait',passed:true},null,
  ],'The profile results must retain each portrait Layers receipt');
  assert.equal(result.offlineCalls.length,1,'The full matrix must retain the existing final offline audit');
  assert.equal(result.reports.length,1);assert.equal(result.reports[0].path,'browser-verification.json');
  assert.equal(result.reports[0].report.verified,true);assert.equal(result.reports[0].report.offlineSafety.passed,true);
 });
}

test('a desktop audit failure propagates unchanged without repeating or continuing the matrix',async()=>{
 const failure=new Error('The tropnik-canvas map did not settle'),calls=[];
 const observed=await dispatchProfiles(true,async(_cdp,profile)=>{calls.push(profile.name);throw failure;}).then(()=>null,error=>error);
 assert.equal(observed,failure);assert.deepEqual(calls,['desktop-webgl']);
});

test('satellite diagnosis runs both real renderer profiles once without the normal map/zoom matrix or release output',async()=>{
 const policy=browserAuditRunPolicy('satellite-continuity');
 assert.deepEqual(policy,{diagnostic:'satellite-continuity',reportFile:'browser-satellite-continuity-diagnostic.json',profiles:['android-portrait','desktop-webgl']});
 assert.equal(browserTraceEnabled(undefined,policy.diagnostic),false,'Satellite diagnosis does not enable CPU/GPU tracing');
 const run=await dispatchProfiles(false,()=>assert.fail('Satellite diagnosis must not invoke the full zoom matrix'),policy,[],undefined,async(cdp,profile,helpers)=>{
  assert.equal(helpers.url,'http://127.0.0.1:4200/tropnik/');assert.equal(typeof cdp.call,'function');
  return{profile:profile.name,engine:profile.engine,passed:true,performance:{layoutShift:0,longestTaskMs:profile.mobile?351:100}};
 });
 assert.deepEqual(run.satelliteCalls,['desktop-webgl','android-portrait']);assert.deepEqual(run.loadCalls,[]);assert.deepEqual(run.mapCalls,[]);assert.equal(run.offlineCalls.length,0);assert.deepEqual(run.zoomDesigns,[]);
 assert.equal(run.reports.length,2);assert.equal(run.reports[0].report.status,'running');
 const {path,report}=run.reports[1];assert.equal(path,'browser-satellite-continuity-diagnostic.json');assert.equal(report.status,'completed');
 assert.equal(report.profiles.length,2);assert.equal(report.performancePassed,false);assert.equal(report.performanceIssues[0].limit,350);assert.equal(report.performanceIssues[0].value,351);
 assert.equal(report.diagnosticOnly,true);assert.equal(report.verified,false);assert.equal(report.releaseEligible,false);assert.throws(()=>assertBrowserReport(report,'a'.repeat(40)));
});

test('satellite failures propagate without retrying a profile or claiming a complete diagnostic',async()=>{
 const failure=new Error('NASA imagery transfer failed'),calls=[];
 const observed=await dispatchProfiles(false,()=>assert.fail('No full matrix fallback'),browserAuditRunPolicy('satellite-continuity'),[],undefined,async(_cdp,profile)=>{calls.push(profile.name);throw failure;}).then(()=>null,error=>error);
 assert.equal(observed,failure);assert.deepEqual(calls,['desktop-webgl']);
});

for(const [mode,names,rate]of [['ui-smoothness',['desktop-webgl','android-portrait'],1],['ui-smoothness-cpu',['android-portrait'],4]]){
 test(`${mode} runs only its short real-input profiles and cannot publish release evidence`,async()=>{
  const policy=browserAuditRunPolicy(mode);
  const run=await dispatchProfiles(false,()=>assert.fail('Short smoothness must not invoke zoom matrix'),policy);
  assert.deepEqual(run.smoothnessCalls,names.map(profile=>({profile,rate})));
  assert.deepEqual(run.mapCalls,[]);assert.deepEqual(run.loadCalls,[]);assert.equal(run.offlineCalls.length,0);assert.deepEqual(run.zoomDesigns,[]);
  const report=run.reports.at(-1).report;assert.equal(report.status,'completed');assert.equal(report.diagnosticOnly,true);assert.equal(report.verified,false);assert.equal(report.releaseEligible,false);assert.equal(report.performancePassed,true);assert.equal(report.profiles.length,names.length);
  assert.throws(()=>assertBrowserReport(report,'a'.repeat(40)));
 });
}

test('focused map diagnosis runs the exact fresh desktop interaction once and cannot produce release or zoom evidence',async()=>{
 const policy=browserAuditRunPolicy('map-interactions'),issues=[{profile:'desktop-webgl',phase:'map-interactions',metric:'longestTaskMs',value:851,limit:750}];
 const run=await dispatchProfiles(browserTraceEnabled(undefined,policy.diagnostic),()=>assert.fail('The diagnostic must not run any zoom matrix'),policy,issues);
 assert.deepEqual(run.loadCalls,['desktop-webgl']);assert.deepEqual(run.mapCalls,['desktop-webgl']);
 assert.deepEqual(run.zoomDesigns,[]);assert.deepEqual(run.results,[]);assert.equal(run.reports.length,1);
 assert.equal(run.offlineCalls.length,0);
 const {path,report}=run.reports[0];assert.equal(path,'browser-map-interactions-diagnostic.json');
 assert.equal(report.diagnosticOnly,true);assert.equal(report.verified,false);assert.equal(report.releaseEligible,false);
 assert.equal(report.sourceCommit,'a'.repeat(40));assert.deepEqual(report.interaction,run.mapInteractions[0]);
 assert.equal(report.performancePassed,false);assert.deepEqual(report.performanceIssues,issues,'A diagnostic retains the unchanged failed750ms gate');
 assert.throws(()=>assertBrowserReport(report,report.sourceCommit));
});

test('offline diagnosis starts blank, runs the exact final audit once and cannot produce map or release evidence',async()=>{
 const policy=browserAuditRunPolicy('offline-safety');
 assert.deepEqual(policy,{diagnostic:'offline-safety',reportFile:'browser-offline-safety-diagnostic.json',profiles:[]});
 const bootstrapStart=source.indexOf('  const initialUrl=');
 const bootstrapEnd=source.indexOf("\n  await cdp.call('Page.enable')",bootstrapStart);
 assert.ok(bootstrapStart>=0&&bootstrapEnd>bootstrapStart,'The actual initial tab navigation must be available');
 const opened=[],startupCalls=[],environment={};
 class BlankCDP{async open(){}async call(method){startupCalls.push(method);}}
 const bootstrap=source.slice(bootstrapStart,bootstrapEnd).replaceAll('import.meta.url',JSON.stringify(new URL('../browser-smoke.mjs',import.meta.url).href));
 await new AsyncFunction('runPolicy','browser','debugPort','httpPort','CDP','environment','collectNativeBrowserSurface',`let cdp;${bootstrap}`)(policy,{requestJSON:async(url,options)=>{opened.push({url,options});return{};}},4300,4200,BlankCDP,environment,async()=>{startupCalls.push('native-surface');return{blank:true};});
 assert.deepEqual(opened,[{url:'http://127.0.0.1:4300/json/new?about%3Ablank',options:{method:'PUT'}}],'Do not warm the map or its service worker before the safety audit');
 assert.deepEqual(startupCalls,['native-surface'],'Environment collection must not navigate to the application before the cold offline audit');
 assert.deepEqual(environment.nativeSurface,{blank:true});
 const receipt={schemaVersion:1,profile:'android-portrait',passed:true,coldNavigation:true};
 const run=await dispatchProfiles(false,()=>assert.fail('Offline diagnosis must not invoke zoom audits'),policy,[],async(cdp,helpers)=>{
  assert.equal(typeof cdp.call,'function');assert.equal(helpers.url,'http://127.0.0.1:4200/tropnik/');
  assert.deepEqual(Object.keys(helpers).sort(),['evaluate','originTransport','pointerAt','pointerSelector','sleep','url','waitValue']);
  assert.deepEqual(Object.keys(helpers.originTransport).sort(),['restore','snapshot','start']);return receipt;
 });
 assert.deepEqual(run.loadCalls,[]);assert.deepEqual(run.mapCalls,[]);assert.deepEqual(run.zoomDesigns,[]);assert.deepEqual(run.results,[]);
 assert.equal(run.offlineCalls.length,1);assert.deepEqual(run.cdpCalls,[{method:'Network.enable',parameters:undefined}]);
 assert.equal(run.reports.length,1);
 const {path,report}=run.reports[0];assert.equal(path,'browser-offline-safety-diagnostic.json');assert.deepEqual(report.offlineSafety,receipt);
 assert.equal(report.diagnosticOnly,true);assert.equal(report.verified,false);assert.equal(report.releaseEligible,false);assert.equal(report.status,'completed');
 assert.equal(report.sourceCommit,'a'.repeat(40));assert.throws(()=>assertBrowserReport(report,report.sourceCommit));
});

test('offline diagnostic failure propagates unchanged without emitting a success receipt or trying map profiles',async()=>{
 const failure=new Error('The saved safety draft did not survive cold navigation');let calls=0;
 const observed=await dispatchProfiles(false,()=>assert.fail('Offline failure must not fall back to a map audit'),browserAuditRunPolicy('offline-safety'),[],async()=>{calls++;throw failure;}).then(()=>null,error=>error);
 assert.equal(observed,failure);assert.equal(calls,1);
});
