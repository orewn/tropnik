import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';
import {assertMapLoadingReceipt} from '../browser-map-loading.mjs';
import {browserEnvironmentFixture} from './browser-environment-fixture.mjs';

const workflow=readFileSync(new URL('../../../.github/workflows/pages.yml',import.meta.url),'utf8');
const deployed=readFileSync(new URL('../verify-deployed.mjs',import.meta.url),'utf8');
const section=(source,startText,endText)=>{
 const start=source.indexOf(startText),end=source.indexOf(endText,start);
 assert.ok(start>=0&&end>start,'Execute the actual map-loading publication checks');return source.slice(start,end);
};
const metadataSource=section(workflow,'          const mapLoading =','          const trailOverlay =').replace(/^ {10}/gm,'');
const publicSource=section(deployed,'const mapLoading =','\nconst homeResponse =');
const metadata=compileFunction(metadataSource+'\nreturn mapLoading;', ['assert','createHash','readFileSync','process','build','browser','assertMapLoadingReceipt']);
const published=compileFunction('return(async()=>{'+publicSource+'\nreturn mapLoading;})();', ['assert','request','expectedCommit','expectedBuild','build','browser','assertMapLoadingReceipt']);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourcePaths=[
 'web/lib/custom-map-engine.ts','web/lib/custom-map-tiles.ts','web/lib/custom-map-camera.ts',
 'web/lib/custom-map-painter.ts','web/lib/custom-map-tiles.worker.ts','web/lib/map-resource-pool.ts',
 'web/lib/map-preload.ts','web/lib/catalog.generated.json','tools/pages-preview/browser-map-loading.mjs',
];

// These opaque bytes exercise publication wiring, not rendering. The observer
// replaces only the receipt assertion to inspect its arguments; no fixture is
// claimed to be a successful browser proof. Separate checks below invoke the
// real assertion and require it to reject this incomplete payload.
function fixture(){
 const commit='a'.repeat(40),buildId='0123456789abcdef',files=new Map(),reads=[],requests=[],validations=[];
 for(const path of sourcePaths)files.set(path,Buffer.from('checked build input '+path));
 const sources=Object.fromEntries(sourcePaths.map(path=>[path,sha(files.get(path))]));
 const build={buildId,inputs:sourcePaths.map(path=>({path,sha256:sources[path],bytes:files.get(path).length}))};
 const browser={environment:browserEnvironmentFixture(commit)};
 const report={sources,profile:{width:1440,height:1000,deviceScaleFactor:1},screenshots:['route','before','pending-progress','complete'].map((phase,index)=>{
  const png=Buffer.alloc(2048,index+1);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(1440,16);png.writeUInt32BE(1000,20);
  const file='map-loading-'+phase+'.png';files.set('web/pages-preview/design-qa/map-loading/'+file,png);
  return{phase,file,bytes:png.length,sha256:sha(png),width:1440,height:1000};
 })};
 const observeValidation=(value,options)=>{
  assert.deepEqual(value,report);assert.deepEqual(options,{sourceCommit:commit,buildId,environment:browser.environment});validations.push(options);
 };
 const read=(path,encoding)=>{
  reads.push(path);if(path==='web/pages-preview/dist/browser-map-loading-verification.json')return JSON.stringify(report);
  assert.ok(files.has(path),'Missing evidence file '+path);const bytes=files.get(path);return encoding?bytes.toString(encoding):bytes;
 };
 const request=async path=>{requests.push(path);assert.equal(path,'browser-map-loading-verification.json');return{text:JSON.stringify(report)};};
 return{report,build,files,reads,requests,validations,
  metadata:validator=>metadata(assert,createHash,read,{env:{GITHUB_SHA:commit}},build,browser,validator??observeValidation),
  public:validator=>published(assert,request,commit,buildId,build,browser,validator??observeValidation),
 };
}

test('the real map-loading gate is mandatory before the full browser audit and retains failure evidence',()=>{
 const step=section(workflow,'      - name: Verify native map progress','      - name: Verify complete trail overlay');
 assert.match(step,/run: node tools\/pages-preview\/browser-map-loading\.mjs/);assert.match(step,/GITHUB_SHA: \$\{\{ github.sha \}\}/);
 assert.doesNotMatch(step,/\b(?:continue-on-error|if):/);
 assert.ok(workflow.indexOf(step)<workflow.indexOf('      - name: Verify real mobile rendering'));
 assert.match(workflow,/import \{assertMapLoadingReceipt\} from '\.\/tools\/pages-preview\/browser-map-loading\.mjs'/);
 assert.match(deployed,/import \{assertMapLoadingReceipt\} from '\.\/browser-map-loading\.mjs'/);
 const failure=section(workflow,'      - name: Preserve browser failure evidence','      - name: Preserve map design checks');
 assert.match(failure,/web\/pages-preview\/dist\/browser-map-loading-verification\.json/);
});

test('build metadata delegates exact source, build and environment validation and checks all nine inputs and four PNGs',()=>{
 const env=fixture(),result=env.metadata();assert.deepEqual(result,env.report);assert.equal(env.validations.length,1);
 assert.deepEqual(env.reads,['web/pages-preview/dist/browser-map-loading-verification.json',...sourcePaths,...env.report.screenshots.map(capture=>'web/pages-preview/design-qa/map-loading/'+capture.file)]);
});

test('local source bytes and both build-input identity fields are independently required',()=>{
 for(const mutate of [
  env=>env.files.set(sourcePaths[0],Buffer.from('changed source after build')),
  env=>env.build.inputs.splice(0,1),
  env=>env.build.inputs[0].sha256='f'.repeat(64),
  env=>env.build.inputs[0].bytes++,
 ]){const env=fixture();mutate(env);assert.throws(()=>env.metadata());assert.equal(env.validations.length,1);}
});

test('every loading screenshot requires its actual file, byte count, SHA256, PNG signature and dimensions',()=>{
 for(let index=0;index<4;index++)for(const mutation of ['missing','bytes','sha256','signature','dimensions','receipt-dimensions','file']){
  const env=fixture(),capture=env.report.screenshots[index],path='web/pages-preview/design-qa/map-loading/'+capture.file,png=env.files.get(path);
  if(mutation==='missing')env.files.delete(path);
  else if(mutation==='bytes')capture.bytes++;
  else if(mutation==='sha256')png[100]^=1;
  else if(mutation==='signature'){png[0]^=1;capture.sha256=sha(png);}
  else if(mutation==='dimensions'){png.writeUInt32BE(1441,16);capture.sha256=sha(png);}
  else if(mutation==='receipt-dimensions'){png.writeUInt32BE(1441,16);capture.sha256=sha(png);capture.width=1441;}
  else capture.file='map-loading-another-phase.png';
  assert.throws(()=>env.metadata(),undefined,capture.phase+'/'+mutation+' must fail the publication boundary');
 }
});

test('the public verifier fetches the required receipt and binds every source hash to the exact public build inputs',async()=>{
 const good=fixture();assert.deepEqual(await good.public(),good.report);assert.equal(good.validations.length,1);assert.deepEqual(good.requests,['browser-map-loading-verification.json']);
 for(const path of sourcePaths)for(const missing of [false,true]){
  const env=fixture(),index=env.build.inputs.findIndex(input=>input.path===path);
  if(missing)env.build.inputs.splice(index,1);else env.build.inputs[index].sha256='f'.repeat(64);
  await assert.rejects(env.public(),/public map loading proof belongs to another source input/);assert.equal(env.validations.length,1);
 }
});

test('neither metadata nor public verification can pass when the real receipt validator rejects the proof',async()=>{
 const env=fixture();assert.throws(()=>env.metadata(assertMapLoadingReceipt));await assert.rejects(env.public(assertMapLoadingReceipt));
 const refusal=()=>{throw new Error('Receipt validation refused');};
 assert.throws(()=>env.metadata(refusal),/Receipt validation refused/);await assert.rejects(env.public(refusal),/Receipt validation refused/);
});
