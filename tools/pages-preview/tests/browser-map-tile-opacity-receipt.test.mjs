import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {TILE_OPACITY_BASELINE,TILE_OPACITY_BASELINE_FILES,TILE_OPACITY_WORKER_FILES,assertTileOpacityWorkerInputs,assertTileOpacitySources,assertTileOpacityFiles} from '../browser-map-tile-opacity-receipt.mjs';

const root=resolve(import.meta.dirname,'../../..');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const files={...TILE_OPACITY_BASELINE_FILES,...TILE_OPACITY_WORKER_FILES};
const fileRecord=async path=>{const bytes=await readFile(join(root,path));return{path,bytes:bytes.length,sha256:sha256(bytes)};};

test('tile opacity worker closures reject missing, duplicate, foreign and unreviewed dependencies',()=>{
 assert.equal(TILE_OPACITY_BASELINE.sourceCommit,'3cb219fdd8380fcf2580bfe37aa7d1f47523ba08');
 assert.equal(TILE_OPACITY_BASELINE.workerSHA256,'25047eadb538c0e08b2e5521349419504961bee8bbb207fde6633f414f2d7217');
 for(const [side,expected]of [['baseline',TILE_OPACITY_BASELINE_FILES],['candidate',TILE_OPACITY_WORKER_FILES]]){
  const paths=Object.keys(expected);assert.equal(paths.length,7);assertTileOpacityWorkerInputs(paths,side);
  for(const path of paths)assert.throws(()=>assertTileOpacityWorkerInputs(paths.filter(value=>value!==path),side),/source closure changed/);
  assert.throws(()=>assertTileOpacityWorkerInputs([...paths,'web/lib/unreviewed-painter.ts'],side),/source closure changed/);
  assert.throws(()=>assertTileOpacityWorkerInputs([...paths,paths[0]],side),/source closure changed/);
  assert.throws(()=>assertTileOpacityWorkerInputs(Object.keys(side==='baseline'?TILE_OPACITY_WORKER_FILES:TILE_OPACITY_BASELINE_FILES),side),/source closure changed/);
 }
});

test('tile opacity source receipts require every exact baseline and candidate file independently',async()=>{
 const records=await Promise.all(Object.keys(files).map(fileRecord));assert.equal(records.length,14);assertTileOpacitySources(records);
 for(const record of records){
  assert.throws(()=>assertTileOpacitySources(records.filter(value=>value!==record)),/Reviewed worker source changed or missing/);
  assert.throws(()=>assertTileOpacitySources(records.map(value=>value===record?{...value,sha256:'0'.repeat(64)}:value)),/Reviewed worker source changed or missing/);
 }
 assert.throws(()=>assertTileOpacitySources([...records,records[0]]));
 const oldPainter=Object.keys(TILE_OPACITY_BASELINE_FILES).find(path=>path.endsWith('/custom-map-painter.ts'));
 const currentPainter=records.find(value=>value.path==='web/lib/custom-map-painter.ts');
 assert.notEqual(files[oldPainter],currentPainter.sha256,'The two paint implementations must not be silently shared');
 assert.throws(()=>assertTileOpacitySources(records.map(value=>value.path===oldPainter?{...currentPainter,path:oldPainter}:value)),/Reviewed worker source changed or missing/);
});

test('tile opacity file verification binds the frozen reference bytes to the exact build input inventory',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'tile-opacity-source-records-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const sources=await Promise.all([...Object.keys(files),'web/public/custom-map/manifest.json'].map(fileRecord));
 const native=await fileRecord('android/app/src/main/assets/custom-map/manifest.json');
 for(const source of [...sources,native]){const destination=join(directory,source.path);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,await readFile(join(root,source.path)));}
 const web=sources.find(value=>value.path==='web/public/custom-map/manifest.json'),manifest=JSON.parse(await readFile(join(directory,web.path),'utf8'));
 // This unit case exercises source/file binding only. Native pixel rows are
 // still required by assertTileOpacityReceipt and the unchanged browser gate.
 const report={sourceCommit:'a'.repeat(40),buildId:'b'.repeat(16),workerSHA256:TILE_OPACITY_WORKER_FILES['web/lib/custom-map-tiles.worker.ts'],sources,runtime:{web,native,sourceInputsSha256:manifest.sourceInputsSha256},cases:[]};
 const build={sourceCommit:report.sourceCommit,buildId:report.buildId,inputs:[...sources]};assertTileOpacityFiles(report,{root:directory,build});
 const baselinePainter=Object.keys(TILE_OPACITY_BASELINE_FILES).find(path=>path.endsWith('/custom-map-painter.ts'));
 assert.throws(()=>assertTileOpacityFiles(report,{root:directory,build:{...build,inputs:build.inputs.filter(source=>source.path!==baselinePainter)}}));
 assert.throws(()=>assertTileOpacityFiles({...report,sources:report.sources.filter(source=>source.path!==baselinePainter)},{root:directory,build}),/Reviewed worker source changed or missing/);
 const filename=join(directory,baselinePainter),original=await readFile(filename);await writeFile(filename,Buffer.concat([original,Buffer.from('\n// changed after build\n')]));
 assert.throws(()=>assertTileOpacityFiles(report,{root:directory,build}));
});
