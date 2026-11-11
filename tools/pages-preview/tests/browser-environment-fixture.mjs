import {BROWSER_ENVIRONMENT_PROFILE,BROWSER_ENVIRONMENT_FLAGS} from '../browser-environment.mjs';

export function nativeSurfaceFixture(){
 return{schemaVersion:1,collection:'blank-target-before-emulation',window:{left:10,top:10,width:1920,height:1920,windowState:'normal'},
  viewport:{url:'about:blank',visibilityState:'visible',innerWidth:1920,innerHeight:1833,outerWidth:1920,outerHeight:1920,devicePixelRatio:1,screen:{width:1920,height:1920,availWidth:1920,availHeight:1920}}};
}

// Unit-test observations only; browser fixtures always collect these through
// the browser CDP target and execute the production renderer themselves.
export function browserEnvironmentFixture(sourceCommit='a'.repeat(40)){
 return{schemaVersion:1,profile:BROWSER_ENVIRONMENT_PROFILE,collection:'browser-target-cdp-before-measurement',sourceCommit,capturedAt:'2026-11-11T14:00:00.000Z',nativeSurface:nativeSurfaceFixture(),
  requestedFlags:[...BROWSER_ENVIRONMENT_FLAGS],commandLine:'/usr/bin/google-chrome '+[...BROWSER_ENVIRONMENT_FLAGS,'--remote-debugging-port=9222','--user-data-dir=/tmp/fixture','--ozone-platform=headless','about:blank'].join(' '),
  browser:{product:'Chrome/156.0.8078.79',revision:'@'+'b'.repeat(40),protocolVersion:'1.3',jsVersion:'15.6.1',userAgent:'Mozilla/5.0 HeadlessChrome/156.0.8078.79'},
  gpu:{devices:[{vendorId:65535,deviceId:65535,vendorString:'Google Inc. (Google)',deviceString:'ANGLE (SwiftShader Device (Subzero))',driverVendor:'SwANGLE',driverVersion:'5.0.0'}],
   auxAttributes:{displayType:'ANGLE_SWIFTSHADER',glImplementationParts:'(gl=egl-angle,angle=swiftshader)',glRenderer:'ANGLE (SwiftShader Device (Subzero))',glVendor:'Google Inc. (Google)',glVersion:'OpenGL ES 3.0 (ANGLE)',skiaBackendType:'None',targetCpuBits:64},
   featureStatus:{gpu_compositing:'disabled_software',rasterization:'disabled_software',webgl:'unavailable_software'}},
  runner:{os:{platform:'linux',release:'6.14.0-test',version:'Ubuntu test fixture',arch:'x64'},cpu:{models:['Unit test CPU'],logicalCount:4,availableParallelism:4},totalMemoryBytes:16*1024**3,image:{os:'ubuntu24',version:'20261101.360.1'}}};
}
export function terrainMaskReportFixture(sourceCommit='a'.repeat(40)){
 const metrics={width:512,height:384,outsideWitnesses:30414,insideWitnesses:22002,nearBoundaryOutside:5575,terrainLeaks:0,routeLeaks:0,nearBoundaryRouteLeaks:0,insideVisible:22002,insideVisibleRatio:1,routeCorePixels:279,routeHaloPixels:384};
 return{schemaVersion:1,verified:true,phase:'complete',evidence:'production-renderer-browser-pixels',sourceCommit,environment:browserEnvironmentFixture(sourceCommit),rendererSHA256:'c'.repeat(64),
  cases:['webgl2','canvas2d'].flatMap(renderer=>[false,true].map(changedView=>{
   const name=`${renderer}-${changedView?'rotated-zoomed':'initial'}`,restores=renderer==='webgl2'&&changedView;
   return{name,verified:true,phase:'complete',renderer,callerMaskMutationChecked:true,view:{rotate:changedView?.61:0,zoom:changedView?1.3:1},metrics:{...metrics},
    recovery:restores?{lost:1,restored:1,trusted:true,metrics:{...metrics}}:null,
    frames:['reference','empty','first-masked-frame','masked-route',...(restores?['context-restored']:[])].map(phase=>({phase,renderer,width:512,height:384,file:`${name}-${phase}.png`,bytes:10000,sha256:'d'.repeat(64)}))};
  }))};
}
