import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {readFileSync} from 'node:fs';
import {MapRenderDensity,softwareMapRenderer,readSoftwareMapRenderer} from '../lib/map-render-density.ts';

const require=createRequire(new URL('../package.json',import.meta.url));
const sdk=await import(join(dirname(require.resolve('maplibre-gl/package.json')),'dist/maplibre-gl.mjs'));

function harness({renderer='ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)',baseline=1,debug=true,lost=false}={}){
 let currentRenderer=renderer,contextLost=lost,extension=debug,contextAvailable=true;
 const reads=[],events=[],dimensions=[],painterSizes=[];
 const gl={RENDERER:0x1F01,isContextLost:()=>contextLost,
  getExtension:name=>{reads.push(['extension',name]);return extension?{UNMASKED_RENDERER_WEBGL:0x9246}:null;},
  getParameter:key=>{reads.push(['parameter',key]);return currentRenderer;}};
 const canvas={width:1041*baseline,height:928*baseline,style:{},getContext:type=>{reads.push(['context',type]);return contextAvailable?gl:null;}};
 // Run the installed Map.setPixelRatio -> resize -> _resizeInternal methods.
 // DOM/WebGL painting is replaced, while the SDK owns resize events, backing
 // sizes and the dimensions delivered to its camera transform.
 const map=Object.assign(Object.create(sdk.Map.prototype),{
  _overridePixelRatio:baseline,_lostContextSnapshot:{style:null},_maxCanvasSize:[8192,8192],
  _canvas:canvas,_containerDimensions:()=>[1041,928],
  _camera:{_moving:false,transform:{resize:(...args)=>dimensions.push(args)},stop(){}},
  painter:{context:{gl},resize:(...args)=>painterSizes.push(args),overLimit:()=>false},
 });
 for(const name of ['movestart','move','resize','moveend'])map.on(name,()=>events.push(name));
 const density=new MapRenderDensity(map);
 return{map,canvas,gl,density,reads,events,dimensions,painterSizes,
  renderer:value=>{currentRenderer=value;},lost:value=>{contextLost=value;},debug:value=>{extension=value;},available:value=>{contextAvailable=value;}};
}

test('only explicitly identified software rasterizers select the density policy',()=>{
 for(const [value,expected] of [
  ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)','swiftshader'],
  ['llvmpipe (LLVM 18.1.8, 256 bits)','llvmpipe'],['softpipe','softpipe'],
 ])assert.equal(softwareMapRenderer(value),expected);
 for(const value of ['WebKit WebGL','ANGLE (Intel, Intel UHD Graphics 620, D3D11)','ANGLE (NVIDIA GeForce RTX 3070)','Apple M2','Mesa Intel(R) UHD Graphics','Google Inc.','HeadlessChrome','SwiftShaderCompatibleGPU',null,42])assert.equal(softwareMapRenderer(value),undefined);
});

test('renderer inspection reads only the existing public context and renderer parameter',()=>{
 const env=harness();assert.equal(readSoftwareMapRenderer(env.canvas),'swiftshader');
 assert.deepEqual(env.reads,[['context','webgl2'],['extension','WEBGL_debug_renderer_info'],['parameter',0x9246]]);
 assert.deepEqual(env.events,[]);assert.equal(env.map.getPixelRatio(),1);
});

test('software terrain reduces backing pixels while the installed SDK retains CSS camera dimensions',()=>{
 const env=harness();env.density.setTerrain(true);
 assert.equal(env.map.getPixelRatio(),.5);assert.equal(env.canvas.width,521);assert.equal(env.canvas.height,464);
 assert.deepEqual(env.dimensions,[[1041,928,true]]);assert.deepEqual(env.painterSizes,[[1041,928,.5]]);
 assert.deepEqual(env.events,['movestart','move','resize','moveend']);
 // The SDK rounds a backing pixel before deriving canvas CSS size. At this
 // odd container width it overcovers by one CSS pixel; it does not shrink the
 // geographic viewport or leave an uncovered edge.
 assert.equal(env.canvas.style.width,'1042px');assert.equal(env.canvas.style.height,'928px');
 assert.ok(env.canvas.width*env.canvas.height<.251*1041*928);
});

test('repeated terrain selection does not resize or restart camera lifecycle events',()=>{
 const env=harness();env.density.setTerrain(true);
 for(let i=0;i<20;i++)env.density.setTerrain(true);
 assert.equal(env.dimensions.length,1);assert.equal(env.events.length,4);
});

test('terrain off restores the originally configured ratio and never inspects GL unnecessarily',()=>{
 const env=harness({baseline:2});env.density.setTerrain(true);const reads=env.reads.length;
 env.density.setTerrain(false);assert.equal(env.map.getPixelRatio(),2);assert.equal(env.canvas.width,2082);assert.equal(env.canvas.height,1856);
 assert.equal(env.reads.length,reads);assert.equal(env.dimensions.length,2);
 env.density.setTerrain(false);assert.equal(env.dimensions.length,2);
});

test('hardware, masked and absent contexts retain their original configured density',()=>{
 for(const renderer of ['ANGLE (AMD, Radeon RX 6800, Vulkan)','ANGLE (Intel, UHD Graphics, D3D11)','Apple M3','WebKit WebGL']){
  const env=harness({renderer,baseline:2});env.density.setTerrain(true);assert.equal(env.map.getPixelRatio(),2);assert.deepEqual(env.events,[]);
 }
 const env=harness({baseline:1.5});env.available(false);env.density.setTerrain(true);assert.equal(env.map.getPixelRatio(),1.5);assert.deepEqual(env.events,[]);
});

test('masked extension denial, GL errors and lost contexts do not select lower density',()=>{
 const masked=harness({debug:false,renderer:'WebKit WebGL'});masked.density.setTerrain(true);assert.deepEqual(masked.events,[]);
 const lost=harness({lost:true});lost.density.setTerrain(true);assert.deepEqual(lost.reads,[['context','webgl2']]);assert.deepEqual(lost.events,[]);
 const failed=harness();failed.gl.getExtension=()=>{throw Error('context denied');};failed.density.setTerrain(true);assert.deepEqual(failed.events,[]);
});

test('a restored hardware context returns to normal density and a restored software context is capped again',()=>{
 const env=harness({baseline:2});env.density.setTerrain(true);env.renderer('ANGLE (Intel UHD Graphics)');
 env.map.terrain={options:{source:'dem'}};env.map.fire(new sdk.MapTerrainEvent({terrain:{source:'dem'}}));
 assert.equal(env.map.getPixelRatio(),2);env.renderer('llvmpipe (LLVM 18.1.8, 256 bits)');env.map.fire(new sdk.MapTerrainEvent({terrain:{source:'dem'}}));
 assert.equal(env.map.getPixelRatio(),.5);assert.equal(env.dimensions.length,3);
});

test('all SDK terrain-off events restore density before any later React state or style callback',()=>{
 const env=harness({baseline:2});
 for(const origin of ['mode','cluster expansion','Russia overview','region selection','style replacement']){
  env.map.terrain={options:{source:'dem'}};env.map.fire(new sdk.MapTerrainEvent({terrain:{source:'dem'},origin}));
  assert.equal(env.map.getPixelRatio(),.5);
  env.map.terrain=null;env.map.fire(new sdk.MapTerrainEvent({terrain:null,origin}));
  assert.equal(env.map.getPixelRatio(),2,origin);
 }
});

test('disposal releases the owned event listener and ignores extracted stale callbacks',()=>{
 const env=harness();const stale=env.map._listeners.terrain[0];
 env.density.dispose();env.map.terrain={options:{source:'dem'}};
 env.map.fire(new sdk.MapTerrainEvent({terrain:{source:'dem'}}));stale();env.density.setTerrain(true);
 assert.equal(env.map.getPixelRatio(),1);assert.deepEqual(env.events,[]);assert.equal(env.map.listens('terrain'),false);
});

test('a preexisting ratio below the cap is preserved rather than increasing render work',()=>{
 const env=harness({baseline:.25});env.density.setTerrain(true);assert.equal(env.map.getPixelRatio(),.25);assert.deepEqual(env.events,[]);
});

test('Atlas applies density before terrain animation and releases both failed and mounted owners',()=>{
 const source=readFileSync(new URL('../components/Atlas.tsx',import.meta.url),'utf8');
 assert.match(source,/if\(next\)\{\s*renderDensity\.current\?\.setTerrain\(true\);/);
 assert.equal((source.match(/density\?\.dispose\(\)/g)||[]).length,2);
 assert.equal((source.match(/if\(renderDensity\.current===density\)renderDensity\.current=null/g)||[]).length,2);
});
