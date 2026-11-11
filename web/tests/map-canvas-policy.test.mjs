import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual capability policy against small browser surfaces. The
// fake document controls context availability, not the policy's classification.
const source=new URL('../lib/map-canvas-policy.ts',import.meta.url);
let compiled;
const plain=value=>({...value});
function loadPolicy(document){
 compiled??=ts.transpileModule(readFileSync(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},fileName:source.pathname}).outputText;
 const testModule={exports:{}};
 const navigator={get userAgent(){assert.fail('Canvas capability must not depend on user-agent strings');}};
 const run=vm.runInNewContext(`(function(module,exports){${compiled}\n})`,{document,navigator});
 run(testModule,testModule.exports);return testModule.exports.mapCanvasPolicy;
}

function browserProbe(options={}){
 const state={renderer:options.renderer??'ANGLE (Intel, Intel(R) UHD Graphics 620, OpenGL 4.6)',createAttempts:0,created:[],contexts:[],extensions:[],parameters:[],lost:0};
 const debug={UNMASKED_RENDERER_WEBGL:0x9246};
 const gl={RENDERER:0x1f01,
  getExtension(name){
   state.extensions.push(name);
   if(name==='WEBGL_debug_renderer_info'){
    if(options.debug==='throws')throw new Error('Renderer metadata is restricted');
    return options.debug==='missing'?null:debug;
   }
   if(name==='WEBGL_lose_context'){
    if(options.cleanup==='missing')return null;
    if(options.cleanup==='extension-throws')throw new Error('Context release extension is unavailable');
    return{loseContext(){state.lost++;if(options.cleanup==='throws')throw new Error('Context already lost');}};
   }
   assert.fail(`Unexpected capability extension ${name}`);
  },
  getParameter(parameter){
   state.parameters.push(parameter);
   if(options.parameter==='throws')throw new Error('Renderer parameter is restricted');
   assert.ok([debug.UNMASKED_RENDERER_WEBGL,gl.RENDERER].includes(parameter));
   return parameter===gl.RENDERER&&options.debug==='missing'?'WebKit WebGL':state.renderer;
  },
 };
 const canvas={width:300,height:150,isConnected:false,
  getContext(kind,attributes){
   state.contexts.push({kind,attributes:plain(attributes),width:this.width,height:this.height});
   if(options.context==='throws')throw new Error('WebGL context creation is blocked');
   return options.context==='missing'?null:gl;
  },
 };
 const document={
  createElement(tag){
   assert.equal(tag,'canvas');
   state.createAttempts++;
   if(options.create==='throws')throw new Error('Cannot create a probe surface');
   state.created.push(canvas);return canvas;
  },
  body:{appendChild(){assert.fail('A capability probe must remain outside the rendered page');}},
 };
 return{document,canvas,gl,state};
}

test('a successful hardware-capable probe preserves normal Canvas and releases its unattached 1×1 context',()=>{
 const env=browserProbe(),policy=loadPolicy(env.document),result=policy();
 assert.deepEqual(plain(result),{softwareRaster:false,reason:'available'});
 assert.equal(Object.isFrozen(result),true);
 assert.throws(()=>{result.softwareRaster=true;},TypeError);
 assert.equal(env.state.created.length,1);assert.equal(env.canvas.isConnected,false);
 assert.equal(env.state.contexts.length,1);
 const probe=env.state.contexts[0];assert.equal(probe.kind,'webgl2');
 assert.deepEqual([probe.width,probe.height],[1,1]);
 assert.equal(probe.attributes.failIfMajorPerformanceCaveat,true);
 assert.equal(env.state.lost,1);
});

test('the runtime policy identifies actual software metadata while preserving hardware and unrelated renderer names',()=>{
 const policy=loadPolicy();
 for(const renderer of [
  'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',
  'llvmpipe (LLVM 19.1.7, 256 bits)','softpipe','lavapipe',
  'Software Rasterizer','Microsoft Basic Render Driver','ANGLE (Microsoft, WARP Direct3D11)',
 ]){
  const env=browserProbe({renderer});
  assert.deepEqual(plain(policy(env.document)),{softwareRaster:true,reason:'software'},renderer);
  assert.equal(env.state.contexts.length,1);assert.equal(env.state.lost,1,renderer);
 }
 for(const renderer of ['ANGLE (NVIDIA, GeForce RTX 3060, OpenGL 4.6)','Apple M3','Adreno (TM) 740','Mali-G715','Warped Fictional GPU']){
  const env=browserProbe({renderer});
  assert.deepEqual(plain(policy(env.document)),{softwareRaster:false,reason:'available'},renderer);
  assert.equal(env.state.lost,1);
 }
});

test('null or blocked context creation selects a bounded fallback and caches that result',()=>{
 const policy=loadPolicy();
 for(const options of [{context:'missing'},{context:'throws'},{create:'throws'}]){
  const env=browserProbe(options),first=policy(env.document);
  assert.deepEqual(plain(first),{softwareRaster:true,reason:'unavailable'});
  assert.equal(Object.isFrozen(first),true);assert.equal(policy(env.document),first);
  assert.equal(env.state.createAttempts,1);
  assert.ok(env.state.created.length<=1);assert.ok(env.state.contexts.length<=1);
  assert.equal(env.state.lost,0);
 }
});

test('privacy-restricted renderer metadata preserves an available context and still releases the probe',()=>{
 const policy=loadPolicy();
 for(const options of [{debug:'missing'},{debug:'throws'},{parameter:'throws'}]){
  const env=browserProbe(options),result=policy(env.document);
  assert.deepEqual(plain(result),{softwareRaster:false,reason:'available'});
  assert.equal(env.state.lost,1);assert.equal(policy(env.document),result);
  assert.equal(env.state.contexts.length,1);
 }
});

test('capability is cached once per Document rather than leaking across distinct browser surfaces',()=>{
 const first=browserProbe(),second=browserProbe({renderer:'SwiftShader'}),policy=loadPolicy(first.document);
 const normal=policy();first.state.renderer='SwiftShader';
 assert.equal(policy(first.document),normal);assert.equal(policy(),normal);
 const software=policy(second.document);assert.notEqual(software,normal);
 assert.deepEqual(plain(normal),{softwareRaster:false,reason:'available'});
 assert.deepEqual(plain(software),{softwareRaster:true,reason:'software'});
 assert.equal(policy(second.document),software);
 for(const env of [first,second]){assert.equal(env.state.created.length,1);assert.equal(env.state.contexts.length,1);assert.equal(env.state.lost,1);}
});

test('an unavailable or already-lost cleanup extension cannot change the detected capability or trigger a new probe',()=>{
 const policy=loadPolicy();
 for(const cleanup of ['missing','extension-throws','throws'])for(const renderer of ['Adreno 740','SwiftShader']){
  const env=browserProbe({cleanup,renderer}),software=renderer==='SwiftShader';
  const result=policy(env.document);
  assert.deepEqual(plain(result),{softwareRaster:software,reason:software?'software':'available'});
  assert.equal(policy(env.document),result);assert.equal(env.state.contexts.length,1);
  assert.equal(env.state.lost,cleanup==='throws'?1:0);
 }
});
