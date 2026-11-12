import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pagesPath,rewriteScript,ts} from '../paths.mjs';
import * as camera from '../../../web/lib/custom-map-camera.ts';
import * as renderer from '../../../web/public/terrain/terrain-renderer.js';

const publicRoot=new URL('../../../web/public/',import.meta.url);
const readerSource=await readFile(new URL('../../../web/lib/terrain-region-sources.ts',import.meta.url),'utf8');
const policySource=await readFile(new URL('../../../web/lib/map-transport.ts',import.meta.url),'utf8');
const manifestBytes=await readFile(new URL('terrain-regions/manifest.json',publicRoot));
const manifest=JSON.parse(manifestBytes);
function compiled(source,name,base){
  const transformed=rewriteScript(source,name,{base});assert.equal(rewriteScript(transformed,name,{base}),transformed);
  const code=ts.transpileModule(transformed,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,exports={};
  new Function('require','exports',code)(specifier=>{
    if(specifier==='./custom-map-camera.ts')return camera;
    if(specifier==='../public/terrain/terrain-renderer.js')return renderer;
    throw new Error('Unexpected regional reader dependency: '+specifier);
  },exports);
  return exports;
}

test('the transformed real reader resolves immutable logical manifest URLs through the public Pages policy',async()=>{
  for(const base of['/tropnik/','/another-project/']){
    const {createTerrainRegionReader,parseTerrainRegions}=compiled(readerSource,'terrain-region-sources.ts',base);
    const {publicMapResourceKey}=compiled(policySource,'map-transport.ts',base),calls=[];
    const load=async url=>{
      assert.ok(url.startsWith(base+'terrain-regions/'),url);assert.equal(publicMapResourceKey(url,'https://example.test'),url);calls.push(url);
      return readFile(new URL(url.slice(base.length),publicRoot));
    };
    const reader=createTerrainRegionReader({loadJSON:async url=>JSON.parse(await load(url)),loadBytes:async url=>{const bytes=await load(url);return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}});
    const regions=parseTerrainRegions(manifest);assert.ok(regions.length>0);
    for(const region of regions){
      assert.ok(await reader.find(region.bounds));
      assert.deepEqual((await reader.grid(region)).bounds,region.bounds);
      assert.equal((await reader.material(region)).byteLength,region.materialBytes);
      assert.throws(()=>parseTerrainRegions({schemaVersion:1,regions:[{...region,gridUrl:base+region.gridUrl.slice(1)}]}),/entry/,'The source validator must continue to require logical paths');
    }
    assert.deepEqual(calls,[base+'terrain-regions/manifest.json',...regions.flatMap(region=>[base+region.gridUrl.slice(1),base+region.materialUrl.slice(1)])]);
    assert.deepEqual(await readFile(new URL('terrain-regions/manifest.json',publicRoot)),manifestBytes);
    for(const url of['/terrain-regions/manifest.json',base+'terrain-regions-private/secret.json',base+'terrain-regions/../api/me',base+'terrain-regions/%2fprivate',base+'api/me','https://untrusted.example/terrain-regions/manifest.json'])assert.equal(publicMapResourceKey(url,'https://example.test'),null,url);
  }
});

test('regional URL rewriting is limited to the public package namespace and preserves regex validation',()=>{
  const base='/tropnik/';
  for(const path of['/terrain-regions/manifest.json','/terrain-regions/south-sakhalin-v1/terrain-grid.json','/terrain-regions/south-sakhalin-v1/surface.png'])assert.equal(pagesPath(path,base),base+path.slice(1));
  for(const path of['/terrain-regions-private/a.json','/terrain-regions_backup/a.json','https://source.example/terrain-regions/a.json'])assert.equal(pagesPath(path,base),path);
  const source=String.raw`const runtime=value.replace(/^\/terrain-regions\//,'/terrain-regions/');`;
  const transformed=rewriteScript(source,'regional-runtime.ts',{base});
  assert.equal(transformed,String.raw`const runtime=value.replace(/^\/terrain-regions\//,'/tropnik/terrain-regions/');`);
});
