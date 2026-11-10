import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MAPLIBRE_TERRAIN_PATCH,restoreMapLibreTerrainFile} from '../scripts/maplibre-terrain-patch.mjs';

const webRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(new URL('../package.json',import.meta.url));
const sdk=dirname(require.resolve('maplibre-gl/package.json'));
const childSequence=[
 {script:'build-trail-connections.mjs',args:['--check'],execArgv:['--experimental-strip-types']},
 {script:'create-map-style.mjs',args:[],execArgv:[]},
 {script:'verify-overview-relief.mjs',args:[],execArgv:[]},
 {script:'build-landscape.mjs',args:[],execArgv:[]},
 {script:'prepare-offline.mjs',args:[],execArgv:[]},
 {script:'stamp-service-worker.mjs',args:[],execArgv:[]},
 {script:'build-region-artwork.mjs',args:['--check'],execArgv:[]},
 {script:'verify-map-shell.mjs',args:[],execArgv:[]},
 {script:'run-framework.mjs',args:['build'],execArgv:[]},
];
const childStub=`import {appendFileSync} from 'node:fs';
import {basename} from 'node:path';
import {fileURLToPath} from 'node:url';
appendFileSync(new URL('../child-events.jsonl',import.meta.url),JSON.stringify({script:basename(fileURLToPath(import.meta.url)),args:process.argv.slice(2),execArgv:process.execArgv})+'\\n');
`;

// The entry point and guard are copied unchanged. Every inspected dependency,
// provenance and offline byte comes from the installed pinned package/repo;
// stock bytes are reconstructed by the hash-checked reverse transform.
// Only downstream child scripts are replaced with invocation recorders. There
// is no browser, server, package installation or installed dependency edit.
async function fixture(t,{stockInstalled=false,stockOffline=false}={}){
 const root=await mkdtemp(join(tmpdir(),'tropnik-build-patch-'));t.after(()=>rm(root,{recursive:true,force:true}));
 async function put(name,bytes){const target=join(root,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);}
 const entries=await Promise.all([
  ...['scripts/build-tropnik.mjs','scripts/maplibre-terrain-patch.mjs',MAPLIBRE_TERRAIN_PATCH.patch,MAPLIBRE_TERRAIN_PATCH.provenance].map(async name=>[name,await readFile(join(webRoot,name))]),
  (async()=>['node_modules/maplibre-gl/package.json',await readFile(join(sdk,'package.json'))])(),
  ...Object.keys(MAPLIBRE_TERRAIN_PATCH.originalSHA256).map(async name=>{
   const installed=await readFile(join(sdk,name),'utf8');
   return[`node_modules/maplibre-gl/${name}`,stockInstalled?restoreMapLibreTerrainFile(name,installed):installed];
  }),
  (async()=>{const installed=await readFile(join(sdk,'dist/maplibre-gl.mjs'),'utf8');return['public/maps/maplibre-gl.mjs',stockOffline?restoreMapLibreTerrainFile('dist/maplibre-gl.mjs',installed):await readFile(join(webRoot,'public/maps/maplibre-gl.mjs'))];})(),
 ]);
 await Promise.all([...entries,...childSequence.map(({script})=>[`scripts/${script}`,childStub])].map(([name,bytes])=>put(name,bytes)));
 return root;
}

async function treeSnapshot(root){
 const entries=[];
 async function visit(directory){
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const path=join(directory,entry.name),name=relative(root,path);
   if(entry.isDirectory()){entries.push({name,type:'directory'});await visit(path);}
   else{assert.equal(entry.isFile(),true);entries.push({name,type:'file',sha256:createHash('sha256').update(await readFile(path)).digest('hex')});}
  }
 }
 await visit(root);return entries;
}

function runBuild(root){
 const result=spawnSync(process.execPath,['scripts/build-tropnik.mjs'],{cwd:root,encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024});
 assert.equal(result.error,undefined,'The actual entry point must finish, rather than time out or fill the output buffer');
 assert.equal(result.signal,null);return result;
}

test('stock installed SDK with the patched offline bundle aborts before any child or file mutation',async t=>{
 const root=await fixture(t,{stockInstalled:true}),before=await treeSnapshot(root),result=runBuild(root);
 assert.notEqual(result.status,0);assert.match(result.stderr,/Expected one patched (?:bundle|source) helper/);
 assert.deepEqual(await treeSnapshot(root),before,'The failed guard must leave all files/directories unchanged, with no child-events log');
});

test('patched installed SDK with a stock offline bundle aborts before prepare-offline can overwrite it',async t=>{
 const root=await fixture(t,{stockOffline:true}),before=await treeSnapshot(root),result=runBuild(root);
 assert.notEqual(result.status,0);assert.match(result.stderr,/Offline and imported MapLibre bundles differ/);
 assert.deepEqual(await treeSnapshot(root),before,'The failed guard must run before the first child or any source mutation');
});

test('matching patched inputs preserve every build child, argument and invocation order',async t=>{
 const root=await fixture(t),before=await treeSnapshot(root),result=runBuild(root);
 assert.equal(result.status,0,'The valid pinned patch must allow the full entry-point sequence');
 const events=(await readFile(join(root,'child-events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(events,childSequence);
 const after=(await treeSnapshot(root)).filter(entry=>entry.name!=='child-events.jsonl');
 assert.deepEqual(after,before,'Only the invocation recorder may change fixture files');
});
