import test from 'node:test';
import assert from 'node:assert/strict';
import {softwareMapRenderer,readSoftwareMapRenderer} from '../lib/map-renderer-capabilities.ts';
import {terrainPitchForZoom} from '../lib/map-camera-profile.ts';

test('only explicitly named software rasterizers opt into the diagnostic pitch cap',()=>{
 for(const [reported,expected] of [
  ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)','swiftshader'],
  ['llvmpipe (LLVM 15.0.7, 256 bits)','llvmpipe'],
  ['softpipe','softpipe'],
 ])assert.equal(softwareMapRenderer(reported),expected);
 for(const reported of [undefined,null,42,{},'', 'WebKit WebGL','ANGLE (Intel, Intel(R) UHD Graphics, OpenGL)',
  'Apple M2','Adreno (TM) 740','Software Renderer','notSwiftShader','llvmpipex','softpipeline']){
  assert.equal(softwareMapRenderer(reported),undefined,`${String(reported)} must keep the existing profile`);
  for(const [zoom,focused,expected] of [[2,false,14],[4,false,22],[6,false,32],[8,false,42],[12,false,46],
   [2,true,20],[4,true,28],[6,true,38],[8,true,46],[12,true,50]]){
   assert.equal(terrainPitchForZoom(zoom,focused,softwareMapRenderer(reported)),expected);
  }
 }
 for(const renderer of ['swiftshader','llvmpipe','softpipe']){
  for(const focused of [false,true])for(const zoom of [2,4,6,8,12]){
   assert.equal(terrainPitchForZoom(zoom,focused,renderer),Math.min(terrainPitchForZoom(zoom,focused),30));
  }
 }
});

test('the capability reader uses only the map canvas existing WebGL2 context and honors restoration changes',()=>{
 const calls=[],debug={UNMASKED_RENDERER_WEBGL:37446};let renderer='ANGLE (SwiftShader Device (Subzero))';
 const gl={RENDERER:7937,isContextLost:()=>false,
  getExtension:name=>{calls.push(['extension',name]);return debug;},
  getParameter:parameter=>{calls.push(['parameter',parameter]);return renderer;}};
 const canvas={getContext:type=>{calls.push(['context',type]);return gl;}};
 assert.equal(readSoftwareMapRenderer(canvas),'swiftshader');
 assert.deepEqual(calls,[['context','webgl2'],['extension','WEBGL_debug_renderer_info'],['parameter',debug.UNMASKED_RENDERER_WEBGL]]);
 renderer='Apple M2';assert.equal(readSoftwareMapRenderer(canvas),undefined,'a restored hardware context is not cached as software');
 renderer='llvmpipe (LLVM 15.0.7, 256 bits)';assert.equal(readSoftwareMapRenderer(canvas),'llvmpipe');
});

test('missing, lost, masked, or inaccessible context capabilities keep the ordinary profile',()=>{
 assert.equal(readSoftwareMapRenderer({getContext:()=>null}),undefined);
 assert.equal(readSoftwareMapRenderer({getContext:()=>{throw new Error('Context unavailable');}}),undefined);
 assert.equal(readSoftwareMapRenderer({getContext:()=>({isContextLost:()=>true})}),undefined);
 assert.equal(readSoftwareMapRenderer({getContext:()=>({isContextLost:()=>false,getExtension:()=>{throw new Error('Extension unavailable');}})}),undefined);
 const gl={RENDERER:7937,isContextLost:()=>false,getExtension:()=>null,getParameter:parameter=>{
  assert.equal(parameter,7937);return 'WebKit WebGL';
 }};
 assert.equal(readSoftwareMapRenderer({getContext:()=>gl}),undefined);
 gl.getParameter=parameter=>{assert.equal(parameter,7937);return 'softpipe';};
 assert.equal(readSoftwareMapRenderer({getContext:()=>gl}),'softpipe','a known unmasked public renderer also identifies software');
});
