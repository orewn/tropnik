import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {MAPLIBRE_TERRAIN_PATCH,transformMapLibreTerrainFile,restoreMapLibreTerrainFile,verifyMapLibreTerrainPatch} from '../scripts/maplibre-terrain-patch.mjs';

const webRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(new URL('../package.json',import.meta.url)),ts=require('typescript');
const sdk=dirname(require.resolve('maplibre-gl/package.json')),sdkRequire=createRequire(resolve(sdk,'package.json')),modules=new Map();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

// Load the actual installed Terrain, TerrainTileManager, TerrainCoverage and
// RenderToTexture graph. Only browser reduced-motion detection is mocked.
// MLT ships extensionless ESM imports, so its real JS passes through this same
// offline loader. import.meta retains the source module's actual file URL.
const importMeta=context=>{
 const visit=node=>ts.isMetaProperty(node)&&node.keywordToken===ts.SyntaxKind.ImportKeyword?ts.factory.createIdentifier('__sdkImportMeta'):ts.visitEachChild(node,visit,context);
 return node=>ts.visitNode(node,visit);
};
function load(input){
 const path=existsSync(input)?input:[input+'.js',input+'.ts',resolve(input,'index.js')].find(existsSync);
 assert.ok(path,`Unresolved installed SDK import: ${input}`);
 if(path.endsWith('/util/browser.ts'))return{browser:{prefersReducedMotion:false}};
 if(modules.has(path))return modules.get(path).exports;
 const loadedModule={exports:{}};modules.set(path,loadedModule);
 const compiled=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true,useDefineForClassFields:false},transformers:{before:[importMeta]}}).outputText;
 new Function('require','module','exports','__sdkImportMeta',compiled)(id=>id.startsWith('.')?load(resolve(dirname(path),id)):id==='@maplibre/mlt'?load(sdkRequire.resolve(id)):createRequire(path)(id),loadedModule,loadedModule.exports,{url:pathToFileURL(path).href});
 return loadedModule.exports;
}
const {Terrain}=load(resolve(sdk,'src/render/terrain.ts'));
const {TerrainTileManager}=load(resolve(sdk,'src/tile/terrain_tile_manager.ts'));
const {TerrainCoverage}=load(resolve(sdk,'src/render/terrain_coverage.ts'));
const {RenderToTexture}=load(resolve(sdk,'src/webgl/render_to_texture.ts'));

function assigns(body,property){
 let found=false;
 function visit(node){
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(node.left)&&node.left.expression.kind===ts.SyntaxKind.ThisKeyword&&node.left.name.text===property)found=true;
  ts.forEachChild(node,visit);
 }
 visit(body);return found;
}

// Exercise the shipped production/development constructors themselves. The
// transient module only adds test exports for the existing class declarations;
// no constructor, helper, RTT calculation or installed file is rewritten.
async function bundleConstructors(name){
 const path=resolve(sdk,`dist/${name}`),original=readFileSync(path,'utf8'),ast=ts.createSourceFile(path,original,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),classes=new Map(),edits=[];
 function visit(node){
  if(ts.isClassExpression(node)||ts.isClassDeclaration(node)){
   const constructor=node.members.find(ts.isConstructorDeclaration);
   if(constructor?.body)for(const [property,label]of[['qualityFactor','Terrain'],['rttSize','RenderToTexture']])if(assigns(constructor.body,property)){
    const identifier=node.name?.text??(ts.isVariableDeclaration(node.parent)&&ts.isIdentifier(node.parent.name)?node.parent.name.text:null);
    assert.ok(identifier,`${name}: expose the existing ${label} declaration`);assert.equal(classes.has(label),false,`${name}: one ${label} class`);classes.set(label,identifier);
   }
  }
  ts.forEachChild(node,visit);
 }
 visit(ast);assert.equal(classes.size,2);
 for(const node of ast.statements)if(ts.isImportDeclaration(node)&&node.moduleSpecifier.text.startsWith('.'))edits.push({start:node.moduleSpecifier.getStart(ast),end:node.moduleSpecifier.end,text:JSON.stringify(pathToFileURL(resolve(dirname(path),node.moduleSpecifier.text)).href)});
 let code=original;for(const edit of edits.sort((a,b)=>b.start-a.start))code=code.slice(0,edit.start)+edit.text+code.slice(edit.end);
 code+='\nexport {'+[...classes].map(([label,identifier])=>`${identifier} as __Test${label}`).join(',')+'};\n';
 code+=`//# sourceURL=tropnik-test-${name}\n`;
 let loaded;
 try{loaded=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));}
 catch(error){throw new Error(`${name}: actual bundle failed to load: ${error.message}`);}
 return{label:name,Terrain:loaded.__TestTerrain,RenderToTexture:loaded.__TestRenderToTexture};
}
const variants=[{label:'installed TypeScript',Terrain,RenderToTexture},...await Promise.all(['maplibre-gl.mjs','maplibre-gl-dev.mjs'].map(bundleConstructors))];

function publicGL(options={}){
 const {extension=true,extensionError=false,parameterError=false,missingMethods=false}=options;
 const renderer=Object.hasOwn(options,'renderer')?options.renderer:'ANGLE (Google, Vulkan (SwiftShader Device (Subzero)), SwiftShader driver)';
 const calls=[],debug={UNMASKED_RENDERER_WEBGL:0x9246};
 const gl=missingMethods?{}:{
  getExtension(name){assert.equal(this,gl);assert.equal(name,'WEBGL_debug_renderer_info');calls.push({method:'getExtension',argument:name});if(extensionError)throw new Error('Extension query unavailable');return extension?debug:null;},
  getParameter(parameter){assert.equal(this,gl);assert.equal(parameter,debug.UNMASKED_RENDERER_WEBGL);calls.push({method:'getParameter',argument:parameter});if(parameterError)throw new Error('Renderer query unavailable');return renderer;},
 };
 return{gl,calls};
}
function construct(variant,options={}){
 const reader=publicGL(options),source={type:'raster-dem',tileSize:512,minzoom:0,maxzoom:14},manager={_source:source},painter={context:{gl:reader.gl}},specification={source:'terrain-dem',exaggeration:1.12};
 let terrain,rtt;
 try{terrain=new variant.Terrain(painter,manager,specification);rtt=new variant.RenderToTexture(painter,terrain);}
 catch(error){throw new Error(`${variant.label}: actual constructor failed: ${error.message}`);}
 return{...reader,source,manager,painter,specification,terrain,rtt};
}
function geometryIsPreserved(fixture,quality){
 const {terrain,rtt,source,manager,painter,specification}=fixture;
 assert.equal(terrain.qualityFactor,quality);assert.equal(rtt.rttSize,quality===1?1024:2048);
 assert.equal(terrain.meshSize,128);assert.equal(terrain.exaggeration,1.12);assert.equal(terrain._terrainSkirtLength,'auto');assert.equal(terrain.options,specification);assert.equal(terrain.painter,painter);
 assert.equal(terrain.tileManager.tileSize,1024);assert.equal(terrain.tileManager.deltaZoom,1);assert.equal(terrain.tileManager.getSource(),source);assert.equal(manager.tileSize,1024);assert.equal(manager.usedForTerrain,true);
 assert.deepEqual(source,{type:'raster-dem',tileSize:512,minzoom:0,maxzoom:14});assert.equal(rtt.terrain,terrain);assert.equal(rtt.painter,painter);
 assert.equal(terrain._fbo,undefined,'Constructor policy does not allocate or resize a depth framebuffer');
 assert.equal(terrain._heightMapFbo,undefined);assert.equal(terrain._emptyDemTexture,undefined);assert.deepEqual(Object.keys(terrain._meshCache),[]);
}

for(const variant of variants){
 test(`${variant.label}: known SwiftShader names choose 1024 RTTs with unchanged terrain geometry`,()=>{
  for(const renderer of ['SwiftShader','swiftshader','SWIFTSHADER','ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)']){
   const fixture=construct(variant,{renderer});geometryIsPreserved(fixture,1);
   assert.deepEqual(fixture.calls.map(call=>call.method),['getExtension','getParameter'],'One public renderer read per Terrain construction');
   if(variant.Terrain===Terrain){assert.ok(fixture.terrain.tileManager instanceof TerrainTileManager);assert.ok(fixture.terrain.coverage instanceof TerrainCoverage);}
  }
 });

 test(`${variant.label}: hardware, unknown names and non-string values retain 2048 RTTs`,()=>{
  const nonString={toString:()=>assert.fail('Unknown renderer values must not be coerced')};
  for(const renderer of ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4070, OpenGL)','Intel(R) UHD Graphics 630','Apple M2','llvmpipe (LLVM 15.0.7, 256 bits)','Software Rasterizer','WebKit WebGL','Google Inc. (Google)','SwiftShaderRenderer','NotSwiftShader','',null,undefined,123,nonString]){
   const fixture=construct(variant,{renderer});geometryIsPreserved(fixture,2);assert.deepEqual(fixture.calls.map(call=>call.method),['getExtension','getParameter']);
  }
 });

 test(`${variant.label}: missing or failed public renderer queries preserve the default`,()=>{
  for(const options of [{extension:false},{extensionError:true},{parameterError:true},{missingMethods:true}]){
   const fixture=construct(variant,options);geometryIsPreserved(fixture,2);
   assert.deepEqual(fixture.calls.map(call=>call.method),options.missingMethods?[]:options.parameterError?['getExtension','getParameter']:['getExtension']);
  }
 });

 test(`${variant.label}: a new Terrain after context replacement reads the new renderer`,()=>{
  const first=construct(variant);geometryIsPreserved(first,1);first.terrain.destroy();
  assert.equal(first.manager.usedForTerrain,false);assert.equal(first.manager.tileSize,null);assert.equal(first.calls.length,2);
  const restored=publicGL({renderer:'ANGLE (Intel, Intel Iris Xe Graphics, OpenGL)'});first.painter.context.gl=restored.gl;
  const nextManager={_source:first.source},terrain=new variant.Terrain(first.painter,nextManager,first.specification),rtt=new variant.RenderToTexture(first.painter,terrain);
  geometryIsPreserved({...first,manager:nextManager,terrain,rtt},2);
  assert.deepEqual(restored.calls.map(call=>call.method),['getExtension','getParameter']);assert.equal(first.calls.length,2,'The previous context is not queried again');assert.equal(first.rtt.rttSize,1024,'Existing RTT instances are not mutated by a later constructor');
 });
}

test('the pinned patch regenerates exactly and the offline viewer ships identical production bytes',async()=>{
 assert.equal(JSON.parse(readFileSync(resolve(sdk,'package.json'),'utf8')).version,'6.16.0');
 const receipt=await verifyMapLibreTerrainPatch({webRoot,packageRoot:sdk,regenerate:true});assert.equal(receipt.version,'6.16.0');assert.equal(receipt.id,MAPLIBRE_TERRAIN_PATCH.id);
 const production=readFileSync(resolve(sdk,'dist/maplibre-gl.mjs')),offline=readFileSync(resolve(webRoot,'public/maps/maplibre-gl.mjs'));
 assert.deepEqual(offline,production);assert.equal(sha(offline),receipt.offlineBundle.sha256);
 const patch=readFileSync(resolve(webRoot,MAPLIBRE_TERRAIN_PATCH.patch),'utf8');
 const paths=[...patch.matchAll(/^diff --git a\/(\S+) b\/\1$/gm)].map(match=>match[1]).sort();
 assert.deepEqual(paths,Object.keys(MAPLIBRE_TERRAIN_PATCH.originalSHA256).sort(),'Only Terrain source and the two main bundles belong to this patch');
 for(const name of ['dist/maplibre-gl.mjs','dist/maplibre-gl-dev.mjs']){
  const code=readFileSync(resolve(sdk,name),'utf8');assert.doesNotMatch(code,/sourceMappingURL=/);assert.match(code,/MapLibre GL JS[\s\S]{0,150}@license 3-Clause BSD/);
 }
});

test('source and both runtime bundles reject unexpected upstream or patched bytes',()=>{
 for(const [name,expected]of Object.entries(MAPLIBRE_TERRAIN_PATCH.originalSHA256)){
  const patched=readFileSync(resolve(sdk,name),'utf8'),original=restoreMapLibreTerrainFile(name,patched);
  assert.equal(sha(original),expected);assert.equal(transformMapLibreTerrainFile(name,original),patched);
  assert.throws(()=>transformMapLibreTerrainFile(name,original+'\n'),/Unpinned MapLibre input/);
  assert.throws(()=>restoreMapLibreTerrainFile(name,patched+'\n'),/unexpected change/);
 }
});
