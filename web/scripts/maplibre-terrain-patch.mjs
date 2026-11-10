import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,realpath,mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const MAPLIBRE_TERRAIN_PATCH={
 id:'maplibre-6.16.0-swiftshader-terrain-rtt',package:'maplibre-gl',version:'6.16.0',
 integrity:'sha512-gApO66EMtoDZuio680RUBvskR7ahFd/NNhLN4tBAs+Y7FeT4gQV8zVFgYVMRmFxQznOEzecW19w6xOd9XjZjiA==',
 patch:'patches/maplibre-gl@6.16.0.patch',provenance:'patches/maplibre-gl@6.16.0.swiftshader-rtt.json',
 originalSHA256:{
  'src/render/terrain.ts':'f6c5aa12793d015713b2148489d95b1e03000183124c78458e1bb412560a5884',
  'dist/maplibre-gl.mjs':'fbbdf8ddd9a48e49059a4be6795a4f214a711314bb5809f72d3730b48e7897e3',
  'dist/maplibre-gl-dev.mjs':'6b18e66c2f8a7f2eb12b582c441a9b8043a76b165ee0b0d1206e827dc9999e32',
 },
};
const web=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const helper=`// Tropnik: keep terrain coverage and mesh detail while bounding SwiftShader's RTT raster work.
function tropnikTerrainTextureQualityFactor(gl: WebGL2RenderingContext): number {
    try {
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
        return typeof renderer === 'string' && /\\bswiftshader\\b/i.test(renderer) ? 1 : 2;
    } catch {
        return 2;
    }
}

`;
const runtimeHelper=helper.replace('gl: WebGL2RenderingContext): number','gl)');
const license=`/**\n* MapLibre GL JS\n* @license 3-Clause BSD. Full text of license: https://github.com/maplibre/maplibre-gl-js/blob/v6.16.0/LICENSE.txt\n*/\n`;
const sourceAnchor='/**\n * @experimental';
const mapPolicy='// Tropnik: upstream source map is intentionally unlinked after the pinned terrain patch.';
const files=Object.keys(MAPLIBRE_TERRAIN_PATCH.originalSHA256).sort();

function once(text,from,to,label){
 const index=text.indexOf(from);assert.ok(index>=0&&text.indexOf(from,index+from.length)<0,`Expected one ${label}`);
 return text.slice(0,index)+to+text.slice(index+from.length);
}

export function transformMapLibreTerrainFile(name,original){
 assert.equal(sha(original),MAPLIBRE_TERRAIN_PATCH.originalSHA256[name],`Unpinned MapLibre input: ${name}`);
 let text=Buffer.isBuffer(original)?original.toString('utf8'):original;
 if(name==='src/render/terrain.ts'){
  text=once(text,sourceAnchor,helper+sourceAnchor,'terrain source anchor');
  return once(text,'this.qualityFactor = 2;','this.qualityFactor = tropnikTerrainTextureQualityFactor(painter.context.gl);','source quality assignment');
 }
 text=once(text,license,license+runtimeHelper,'unchanged upstream license');
 const production=name==='dist/maplibre-gl.mjs';
 text=once(text,production?'this.qualityFactor=2':'this.qualityFactor = 2;',production?'this.qualityFactor=tropnikTerrainTextureQualityFactor(this.painter.context.gl)':'this.qualityFactor = tropnikTerrainTextureQualityFactor(this.painter.context.gl);','bundle quality assignment');
 return once(text,`//# sourceMappingURL=${name.slice('dist/'.length)}.map`,mapPolicy,'source map reference');
}

export function restoreMapLibreTerrainFile(name,patched){
 let text=Buffer.isBuffer(patched)?patched.toString('utf8'):patched;
 if(name==='src/render/terrain.ts'){
  text=once(text,helper+sourceAnchor,sourceAnchor,'patched source helper');
  text=once(text,'this.qualityFactor = tropnikTerrainTextureQualityFactor(painter.context.gl);','this.qualityFactor = 2;','patched source assignment');
 }else{
  text=once(text,license+runtimeHelper,license,'patched bundle helper');
  const production=name==='dist/maplibre-gl.mjs';
  text=once(text,production?'this.qualityFactor=tropnikTerrainTextureQualityFactor(this.painter.context.gl)':'this.qualityFactor = tropnikTerrainTextureQualityFactor(this.painter.context.gl);',production?'this.qualityFactor=2':'this.qualityFactor = 2;','patched bundle assignment');
  text=once(text,mapPolicy,`//# sourceMappingURL=${name.slice('dist/'.length)}.map`,'source map policy');
 }
 assert.equal(sha(text),MAPLIBRE_TERRAIN_PATCH.originalSHA256[name],`Patched file contains an unexpected change: ${name}`);
 return text;
}

async function readPackage(packageRoot,{patched=false}={}){
 const metadata=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
 assert.equal(metadata.name,MAPLIBRE_TERRAIN_PATCH.package);assert.equal(metadata.version,MAPLIBRE_TERRAIN_PATCH.version);
 const contents={};
 for(const name of files){
  const content=await readFile(join(packageRoot,name),'utf8');
  const original=patched?restoreMapLibreTerrainFile(name,content):content;
  assert.equal(sha(original),MAPLIBRE_TERRAIN_PATCH.originalSHA256[name],`Unpinned package file: ${name}`);
  contents[name]={original,patched:transformMapLibreTerrainFile(name,original)};
  if(patched)assert.equal(content,contents[name].patched,`Noncanonical patch: ${name}`);
 }
 return contents;
}

/** Only edits the disposable directory extracted by pnpm patch --edit-dir.
 * Installed dependencies are read-only; their mutations belong to pnpm. */
export async function writeMapLibreTerrainPatch(packageRoot){
 const physical=await realpath(packageRoot);
 assert.ok(!physical.split(/[\\/]/).includes('node_modules'),'Use an external pnpm patch edit directory, never installed node_modules');
 const contents=await readPackage(physical);
 for(const name of files)await writeFile(join(physical,name),contents[name].patched);
 return Object.fromEntries(files.map(name=>[name,{upstreamSHA256:sha(contents[name].original),patchedSHA256:sha(contents[name].patched)}]));
}

/** Canonical git-format patch, generated only from hash-pinned original bytes.
 * Temporary files are owned by this call and are always removed. */
export async function generateMapLibreTerrainPatch(packageRoot,{patched=false}={}){
 const contents=await readPackage(packageRoot,{patched}),temporary=await mkdtemp(join(tmpdir(),'tropnik-maplibre-patch-'));
 try{
  for(const name of files)for(const [directory,key]of[['a','original'],['b','patched']]){
   const path=join(temporary,directory,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,contents[name][key]);
  }
  const result=spawnSync('git',['-c','core.autocrlf=false','-c','diff.algorithm=myers','diff','--no-index','--no-ext-diff','--no-textconv','--no-color','--full-index','--no-prefix','--unified=3','a','b'],{cwd:temporary,encoding:'utf8',maxBuffer:4*1024*1024});
  if(result.error)throw result.error;assert.equal(result.status,1,`Patch generation failed: ${result.stderr}`);
  return result.stdout;
 }finally{await rm(temporary,{recursive:true,force:true});}
}

function provenance(contents,patch){
 return{
  schemaVersion:1,id:MAPLIBRE_TERRAIN_PATCH.id,package:MAPLIBRE_TERRAIN_PATCH.package,version:MAPLIBRE_TERRAIN_PATCH.version,
  upstream:{repository:'https://github.com/maplibre/maplibre-gl-js',tag:'v6.16.0',npmIntegrity:MAPLIBRE_TERRAIN_PATCH.integrity,license:'BSD-3-Clause; upstream notices retained'},
  policy:{renderer:'Known SwiftShader unmasked renderer string only',swiftShaderQualityFactor:1,hardwareAndUnknownQualityFactor:2,detection:'Public WEBGL_debug_renderer_info once per Terrain construction; unavailable or failed reads preserve 2',unchanged:['DEM source and coverage','terrain tile size','meshSize 128','canvas pixel ratio','terrain depth buffers','anisotropy','style layers and symbols','worker and CSS']},
  sourceMaps:{policy:'Remove sourceMappingURL from the two changed main bundles rather than attribute modified code to upstream mappings',unchanged:'Worker bundles and their source maps'},
  reason:{evidenceSourceCommit:'701149643684770954107256bd36e3b034888ce8',measurement:'Public disjoint timer queries: 8 sampled 2048x2048 hillshade draws total 2102.930535 ms; sustained samples about 243–249 ms. Samples do not estimate total action GPU time.',intent:'Reduce terrain RTT dimensions to the existing terrain tile size only on SwiftShader; performance and visual acceptance remain required'},
  patch:{path:MAPLIBRE_TERRAIN_PATCH.patch,sha256:sha(patch),bytes:Buffer.byteLength(patch)},
  files:files.map(name=>({path:name,upstreamSHA256:sha(contents[name].original),patchedSHA256:sha(contents[name].patched),upstreamBytes:Buffer.byteLength(contents[name].original),patchedBytes:Buffer.byteLength(contents[name].patched)})),
  offlineBundle:{path:'public/maps/maplibre-gl.mjs',sameBytesAs:'dist/maplibre-gl.mjs',sha256:sha(contents['dist/maplibre-gl.mjs'].patched)},
 };
}

export async function recordMapLibreTerrainPatch(packageRoot,{webRoot=web}={}){
 const contents=await readPackage(packageRoot,{patched:true}),patch=await generateMapLibreTerrainPatch(packageRoot,{patched:true});
 await mkdir(join(webRoot,'patches'),{recursive:true});
 await writeFile(join(webRoot,MAPLIBRE_TERRAIN_PATCH.patch),patch);
 const record=provenance(contents,patch);
 await writeFile(join(webRoot,MAPLIBRE_TERRAIN_PATCH.provenance),JSON.stringify(record,null,2)+'\n');
 await writeFile(join(webRoot,'public/maps/maplibre-gl.mjs'),contents['dist/maplibre-gl.mjs'].patched);
 return record;
}

/** Called by the Pages build before it snapshots inputs. This fails closed if
 * npm imports, the offline viewer, patch bytes or provenance have drifted. */
export async function verifyMapLibreTerrainPatch({webRoot=web,packageRoot=join(webRoot,'node_modules/maplibre-gl'),regenerate=false}={}){
 const contents=await readPackage(packageRoot,{patched:true}),patch=await readFile(join(webRoot,MAPLIBRE_TERRAIN_PATCH.patch),'utf8');
 const record=JSON.parse(await readFile(join(webRoot,MAPLIBRE_TERRAIN_PATCH.provenance),'utf8'));
 assert.deepEqual(record,provenance(contents,patch),'MapLibre patch provenance does not match installed bytes');
 assert.equal(await readFile(join(webRoot,'public/maps/maplibre-gl.mjs'),'utf8'),contents['dist/maplibre-gl.mjs'].patched,'Offline and imported MapLibre bundles differ');
 if(regenerate)assert.equal(patch,await generateMapLibreTerrainPatch(packageRoot,{patched:true}),'MapLibre patch is not reproducible');
 return{id:record.id,package:record.package,version:record.version,patch:record.patch,files:record.files,offlineBundle:record.offlineBundle,sourceMaps:record.sourceMaps};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [command,packageRoot]=process.argv.slice(2);
 if(command==='apply'&&packageRoot)console.log(JSON.stringify(await writeMapLibreTerrainPatch(resolve(packageRoot)),null,2));
 else if(command==='record'&&packageRoot)console.log(JSON.stringify((await recordMapLibreTerrainPatch(resolve(packageRoot))).patch,null,2));
 else if(command==='check'&&!packageRoot)console.log(JSON.stringify(await verifyMapLibreTerrainPatch({regenerate:true}),null,2));
 else throw new Error('Usage: maplibre-terrain-patch.mjs apply <pnpm-edit-dir> | record <patched-dir> | check');
}
