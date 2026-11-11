import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {assertSealedBuildInputs,collectBuildInputPaths} from '../map-clear-build-source.mjs';
import {legacyMapRuntime} from '../custom-map-assets.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const controller='e12454abef64c26f4348c9e2a074d2d2f4a11db9';
const clone=value=>structuredClone(value);
function fixture(){
 const runtime=['components/CustomAtlas.tsx','lib/custom-map-engine.ts','lib/custom-map-tiles.worker.ts','public/maps/russia-viewport.js','public/terrain/terrain-renderer.js'];
 const apkRecord={path:'web/public/downloads/tropnik-preview.apk',bytes:123,sha256:'a'.repeat(64)};
 const records=[...runtime.map(path=>({path:'web/'+path,bytes:Buffer.byteLength(path),sha256:hash(path)})),apkRecord].sort((a,b)=>a.path.localeCompare(b.path));
 const customMapFiles=[{path:'map-runtime.js',sizeBytes:20,sha256:'b'.repeat(64)},{path:'manifest.json',sizeBytes:30,sha256:'c'.repeat(64)}];
 const verifiedCustomMap={runtime:'tropnik-canvas',manifestSha256:'c'.repeat(64),files:[customMapFiles[0]],manifest:customMapFiles[1]};
 const build={schemaVersion:1,sourceCommit:controller,hasApk:true,base:'/tropnik/',origin:'https://orewn.github.io',apiConnected:false,serverCodeIncluded:false,fakeServerResponses:false,immutableOfflinePack:true,inputs:clone(records),customMap:{...clone(verifiedCustomMap),deployedFiles:clone(customMapFiles)},bundledModules:[...runtime]};
 const expectedBuildId=hash(JSON.stringify({base:build.base,origin:build.origin,inputs:build.inputs})).slice(0,16);build.buildId=expectedBuildId;
 return{build,options:{records,controllerCommit:controller,expectedBuildId,verifiedCustomMap,customMapFiles,apkRecord}};
}

test('synthetic source proof keeps controller identity and explicitly excludes new APK/deployed-byte claims',()=>{
 const {build,options}=fixture(),before=JSON.stringify(build);
 const proof=assertSealedBuildInputs(build,options);
 assert.equal(proof.recomputedBuildId,build.buildId);assert.equal(proof.checkoutInputCount,5);
 assert.equal(proof.anonymousApkBytesVerified,false);assert.equal(proof.deployedOutputBytesVerified,false);
 assert.equal(JSON.stringify(build),before,'Retained build header and inputs must remain untouched');
});

for(const [name,mutate] of [
 ['missing source',build=>build.inputs.splice(0,1)],
 ['extra source',build=>build.inputs.push({path:'web/lib/unretained.ts',bytes:1,sha256:'d'.repeat(64)})],
 ['duplicate source',build=>build.inputs.push(clone(build.inputs[0]))],
 ['reordered source',build=>build.inputs.reverse()],
 ['changed source bytes',build=>build.inputs[0].bytes++],
 ['changed source digest',build=>build.inputs[0].sha256='d'.repeat(64)],
 ['unsafe source path',build=>build.inputs[0].path='web/../outside'],
 ['unknown input metadata',build=>build.inputs[0].unchecked=true],
 ['application SHA relabelled as controller',build=>build.sourceCommit='1710b201bfeed52613659ae3e4ca7f26638cb6cb'],
 ['incorrect build ID',build=>build.buildId='0'.repeat(16)],
 ['custom-map source mismatch',build=>build.customMap.manifestSha256='d'.repeat(64)],
 ['missing deployed record',build=>build.customMap.deployedFiles.pop()],
 ['missing actual engine module',build=>build.bundledModules=build.bundledModules.filter(name=>name!=='lib/custom-map-engine.ts')],
 ['unbound runtime module',build=>build.bundledModules.push('lib/not-an-input.ts')],
]){
 test('source proof rejects '+name,()=>{
  const {build,options}=fixture();mutate(build);assert.throws(()=>assertSealedBuildInputs(build,options));
 });
}
test('a forged new build ID cannot excuse omitted inventory records',()=>{
 const {build,options}=fixture();build.inputs.pop();
 build.buildId=hash(JSON.stringify({base:build.base,origin:build.origin,inputs:build.inputs})).slice(0,16);
 assert.throws(()=>assertSealedBuildInputs(build,{...options,expectedBuildId:build.buildId}),/build input/i);
});
test('the APK exception must match the separately verified committed manifest record',()=>{
 const {build,options}=fixture(),records=clone(options.records);
 const apk=records.find(record=>record.path.endsWith('.apk'));apk.sha256='e'.repeat(64);build.inputs=clone(records);
 build.buildId=hash(JSON.stringify({base:build.base,origin:build.origin,inputs:build.inputs})).slice(0,16);
 assert.throws(()=>assertSealedBuildInputs(build,{...options,records,expectedBuildId:build.buildId}),/sole non-checkout input/i);
});
test('rewritten deployed digests are retained metadata and never promoted to checked output bytes',()=>{
 const {build,options}=fixture();build.customMap.deployedFiles[0].sha256='f'.repeat(64);
 const proof=assertSealedBuildInputs(build,options);assert.equal(proof.deployedOutputBytesVerified,false);
 assert.equal(proof.deployedFiles[0].sha256,'f'.repeat(64));
});

test('inventory is reconstructed from files and applies every builder source/public filter',async t=>{
 const root=await mkdtemp(join(tmpdir(),'tropnik-sealed-inputs-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const info=['about','safety','safety/registration','sources','privacy','terms','offline','trips','community','guides','planner','account','account/action','search','moderation','android'];
 const app=['page.tsx','not-found.tsx','regions/[id]/page.tsx','routes/[id]/page.tsx','sheet.css',...info.map(name=>name+'/page.tsx')].map(name=>'web/app/'+name);
 const included=['web/app/layout.tsx',...app,'web/components/A.tsx','web/components/deep/api.ts','web/components/theme.css','web/lib/logic.mts','web/lib/data.json','web/pages-preview/src/plain.txt','web/public/data/area.geojson','web/public/custom-map/map-runtime.js','web/public/custom-map/manifest.json','web/package.json','tools/pages-preview/build.mjs','tools/pages-preview/tests/fixture.txt'];
 const excluded=['web/components/notes.txt','web/lib/api.ts','web/lib/deep/server.ts','web/lib/types.bin','web/public/maps/maplibre-gl.js','web/public/maps/leaflet/main.js','web/public/foo.js.map','web/public/foo.d.ts','web/public/foo.original.txt','web/public/another.apk','web/public/custom-map/android-bootstrap.js'];
 for(const name of [...included,...excluded]){
  await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),name);
 }
 const apkPath='web/public/downloads/tropnik-preview.apk';
 const actual=await collectBuildInputPaths(root,{layoutStyles:['./sheet.css','@fontsource/manrope/latin-400.css'],customMapFiles:[{path:'map-runtime.js'},{path:'manifest.json'}],apkPath,legacyMapRuntime});
 assert.deepEqual(actual,[...included,apkPath].sort((a,b)=>a.localeCompare(b)));
 for(const name of excluded)assert.equal(actual.includes(name),false);
 await writeFile(join(root,'web/components/added.tsx'),'new immutable checkout input');
 const next=await collectBuildInputPaths(root,{layoutStyles:['./sheet.css'],customMapFiles:[{path:'map-runtime.js'},{path:'manifest.json'}],apkPath,legacyMapRuntime});
 assert.deepEqual(next,([...actual,'web/components/added.tsx']).sort((a,b)=>a.localeCompare(b)),'A source omitted by a retained report remains required by the independent inventory');
});
