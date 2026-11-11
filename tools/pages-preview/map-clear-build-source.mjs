import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve,relative,basename} from 'node:path';
import {pathToFileURL} from 'node:url';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
// This is a reconstruction of this exact read-only builder inventory, not an
// alternate build. Refuse changes to either the inventory code or CSS syntax.
const BUILDER_SHA256='87ec9ad665e2ad7123d8cc2c83ee80fa72732ba29a61ed32ab28d0e82b2c1695';
const LAYOUT_SHA256='96b8201f9cdfdafc72f237882b59e8dbc10478873e0338f2ad95a9ebad31104d';
const INFO_PAGES=['about','safety','safety/registration','sources','privacy','terms','offline','trips','community','guides','planner','account','account/action','search','moderation','android'];
const EXTRA_INPUTS=['web/package.json','web/pnpm-lock.yaml','web/pnpm-workspace.yaml','web/scripts/verify-custom-map.mjs','web/scripts/prepare-offline.mjs','tools/android-build/prepare-custom-map.mjs'];
const safePath=value=>typeof value==='string'&&value.length>0&&!value.includes('\\')&&!value.includes('\0')&&!value.startsWith('/')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
const pathOrder=(a,b)=>a.localeCompare(b);

async function regularFile(root,name){
 assert.ok(safePath(name),'Unsafe source path');
 let current=root;
 const parts=name.split('/');
 for(let index=0;index<parts.length;index++){
  current=join(current,parts[index]);
  const stat=await lstat(current);
  assert.equal(stat.isSymbolicLink(),false,'Symlinked source input: '+name);
  assert.equal(index===parts.length-1?stat.isFile():stat.isDirectory(),true,'Non-regular source input: '+name);
 }
 return readFile(current);
}

async function files(directory){
 const result=[];
 for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>pathOrder(a.name,b.name))){
  assert.equal(entry.isSymbolicLink(),false,'Symlinked inventory entry');
  const name=join(directory,entry.name);
  if(entry.isDirectory())result.push(...await files(name));
  else if(entry.isFile())result.push(name);
  else assert.fail('Non-regular inventory entry: '+name);
 }
 return result;
}

/** Enumerate the exact build.mjs input rules from the checkout, independently
 * of the retained report's list. No compilation, download or writes occur. */
export async function collectBuildInputPaths(root,{layoutStyles,customMapFiles,apkPath,legacyMapRuntime}){
 assert.ok(safePath(apkPath));assert.ok(Array.isArray(layoutStyles));assert.ok(Array.isArray(customMapFiles));
 assert.ok(legacyMapRuntime instanceof RegExp&&!legacyMapRuntime.global&&!legacyMapRuntime.sticky);
 const names=[apkPath,'web/app/layout.tsx'];
 const customPaths=new Set(customMapFiles.map(record=>'custom-map/'+record.path));
 for(const folder of ['components','lib']){
  for(const path of await files(join(root,'web',folder))){
   if(folder==='lib'&&['api.ts','server.ts'].includes(basename(path)))continue;
   if(!/\.(?:[cm]?[jt]sx?|json|css)$/.test(path))continue;
   names.push(relative(root,path));
  }
 }
 for(const name of ['page.tsx','not-found.tsx','regions/[id]/page.tsx','routes/[id]/page.tsx',...layoutStyles.filter(name=>name.startsWith('./')).map(name=>name.slice(2)),...INFO_PAGES.map(name=>name+'/page.tsx')]){
  const path='web/app/'+name;assert.ok(safePath(path));names.push(path);
 }
 for(const path of await files(join(root,'web/pages-preview/src')))names.push(relative(root,path));
 for(const path of await files(join(root,'web/public'))){
  const name=relative(join(root,'web/public'),path);
  if(name.startsWith('custom-map/')&&!customPaths.has(name))continue;
  if(legacyMapRuntime.test(name))continue;
  if(/(?:\.map|\.d\.ts|\.original\.txt)$/.test(name)||/\.apk$/i.test(name))continue;
  names.push(relative(root,path));
 }
 for(const name of [...EXTRA_INPUTS,...(await files(join(root,'tools/pages-preview'))).map(path=>relative(root,path))]){
  try{await lstat(join(root,name));names.push(name);}
  catch(error){if(error.code!=='ENOENT')throw error;}
 }
 assert.equal(new Set(names).size,names.length,'Duplicate expected builder input');
 return names.sort(pathOrder);
}

/** The records must be the complete independently enumerated source snapshot. */
export function assertSealedBuildInputs(build,{records,controllerCommit,expectedBuildId,verifiedCustomMap,customMapFiles,apkRecord}){
 assert.equal(build.schemaVersion,1);assert.equal(build.sourceCommit,controllerCommit);
 assert.equal(build.hasApk,true);assert.equal(build.base,'/tropnik/');assert.equal(build.origin,'https://orewn.github.io');
 assert.equal(build.apiConnected,false);assert.equal(build.serverCodeIncluded,false);assert.equal(build.fakeServerResponses,false);assert.equal(build.immutableOfflinePack,true);
 assert.ok(Array.isArray(build.inputs));
 const paths=new Set();
 for(const record of build.inputs){
  assert.deepEqual(Object.keys(record).sort(),['bytes','path','sha256']);
  assert.ok(safePath(record.path)&&!paths.has(record.path),'Duplicate or unsafe retained input');paths.add(record.path);
  assert.ok(Number.isSafeInteger(record.bytes)&&record.bytes>=0);assert.match(record.sha256,/^[a-f0-9]{64}$/);
 }
 assert.deepEqual(build.inputs,records,'Missing, added, reordered or changed build input');
 const binaryRecords=build.inputs.filter(record=>/\.apk$/i.test(record.path));
 assert.deepEqual(binaryRecords,[apkRecord],'The sole non-checkout input must be the manifest-pinned APK');
 const recomputedBuildId=sha(JSON.stringify({base:build.base,origin:build.origin,inputs:build.inputs})).slice(0,16);
 assert.equal(build.buildId,expectedBuildId);assert.equal(recomputedBuildId,expectedBuildId,'Build ID does not bind these complete inputs');
 assert.ok(build.customMap&&typeof build.customMap==='object');
 const {deployedFiles,...retainedSource}=build.customMap;
 assert.deepEqual(retainedSource,verifiedCustomMap,'Retained custom-map source/runtime manifest differs from actual checkout bytes');
 assert.ok(Array.isArray(deployedFiles));assert.deepEqual(deployedFiles.map(record=>record.path),customMapFiles.map(record=>record.path));
 for(const record of deployedFiles){
  assert.deepEqual(Object.keys(record).sort(),['path','sha256','sizeBytes']);assert.ok(Number.isSafeInteger(record.sizeBytes)&&record.sizeBytes>0);assert.match(record.sha256,/^[a-f0-9]{64}$/);
 }
 assert.ok(Array.isArray(build.bundledModules)&&build.bundledModules.length>0);
 assert.equal(new Set(build.bundledModules).size,build.bundledModules.length);
 for(const module of build.bundledModules){
  assert.equal(typeof module,'string');const name=module.split('?')[0];
  assert.ok(safePath(name)&&paths.has('web/'+name),'Runtime module is not bound to an input: '+module);
 }
 for(const name of ['components/CustomAtlas.tsx','lib/custom-map-engine.ts','lib/custom-map-tiles.worker.ts','public/maps/russia-viewport.js','public/terrain/terrain-renderer.js']){
  assert.ok(build.bundledModules.includes(name),'Missing actual runtime module: '+name);
 }
 return{recomputedBuildId,inputCount:records.length,checkoutInputCount:records.length-1,
  inputsSHA256:sha(JSON.stringify(build.inputs)),bundledModuleCount:build.bundledModules.length,
  customMap:verifiedCustomMap,deployedFiles,appliedInventoryRulesSHA256:BUILDER_SHA256,
  deployedOutputBytesVerified:false,anonymousApkBytesVerified:false,
  apkRecord:{...apkRecord},apkEvidence:'The original retained input and delivery record match the unchanged committed Android manifest. This verification does not download or independently verify APK bytes.',
  deployedEvidence:'Source custom-map outputs are read and hashed from the exact checkout. Base-rewritten deployedFiles are retained producer metadata; their output bytes were not retained in this six-file artifact.'};
}

export async function verifySealedBuildSource(root,build,{sourceCommit,controllerCommit,expectedBuildId}){
 root=resolve(root);
 const git=args=>{
  const result=spawnSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:8*1024*1024});
  if(result.error)throw result.error;
  assert.equal(result.status,0,'Cannot verify immutable checkout: '+result.stderr);
  return result.stdout;
 };
 assert.equal(git(['rev-parse','HEAD']).trim(),sourceCommit);
 git(['diff','--exit-code','HEAD','--']);
 const tracked=new Set(git(['ls-files','-z']).split('\0').filter(Boolean));
 const builder=await regularFile(root,'tools/pages-preview/build.mjs'),layout=await regularFile(root,'web/app/layout.tsx');
 assert.equal(sha(builder),BUILDER_SHA256,'Builder inventory has changed');
 assert.equal(sha(layout),LAYOUT_SHA256,'Re-review layout CSS enumeration if the layout changes');
 const layoutStyles=[...layout.toString('utf8').matchAll(/^import\s+(['"])([^'"\r\n]+\.css)\1;\s*$/gm)].map(match=>match[2]);
 assert.ok(layoutStyles.length>0);assert.deepEqual(build.layoutStyles,layoutStyles);
 const load=path=>import(pathToFileURL(join(root,path)).href);
 const [{verifyCustomMap},{customMapWebRecords,legacyMapRuntime},{readApkManifest,apkFileName,validateApkDelivery}]=await Promise.all([
  load('web/scripts/verify-custom-map.mjs'),load('tools/pages-preview/custom-map-assets.mjs'),load('tools/pages-preview/apk-artifact.mjs')]);
 const customMap=await verifyCustomMap({webRoot:join(root,'web')}),customMapFiles=customMapWebRecords(customMap);
 const metadata=await readApkManifest(join(root,'web/public/downloads/android-manifest.json'));
 validateApkDelivery(build.apk,metadata);
 const apkPath='web/public/downloads/'+apkFileName(metadata),apkRecord={path:apkPath,bytes:metadata.bytes,sha256:metadata.sha256};
 const names=await collectBuildInputPaths(root,{layoutStyles,customMapFiles,apkPath,legacyMapRuntime});
 assert.equal(names.length,2110,'The sealed measurements must bind the original complete input inventory');
 const records=[];
 for(const name of names){
  if(name===apkPath){records.push(apkRecord);continue;}
  assert.ok(tracked.has(name),'Untracked file cannot prove application commit: '+name);
  const bytes=await regularFile(root,name);
  records.push({path:name,bytes:bytes.length,sha256:sha(bytes)});
 }
 const proof=assertSealedBuildInputs(build,{records,controllerCommit,expectedBuildId,verifiedCustomMap:customMap,customMapFiles,apkRecord});
 return{...proof,applicationSourceCommit:sourceCommit,originalBuildSourceCommit:build.sourceCommit,checkoutTrackedFilesUnchanged:true,buildCanonicalSHA256:sha(JSON.stringify(build)),
  immutableCheckoutInputBytes:records.filter(record=>record.path!==apkPath).reduce((sum,record)=>sum+record.bytes,0)};
}
