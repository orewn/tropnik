import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';

// Explicit local diagnostic; never part of the production client or a browser
// acceptance receipt. Both engines receive the exact same current documents.
const web=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=dirname(web);
const require=createRequire(resolve(web,'package.json')),ts=require('typescript');
const options={baseline:'169b0bee9b2bbdb45adfbe71f4162f35f37344d1',output:null};
for(let index=2;index<process.argv.length;index+=2){
 const key=process.argv[index],value=process.argv[index+1];
 assert.ok(value&&(key==='--baseline'||key==='--output'),'Usage: node web/scripts/benchmark-catalog.mjs [--baseline SHA] [--output FILE]');
 options[key.slice(2)]=value;
}
assert.match(options.baseline,/^[a-f0-9]{40}$/);
const digest=value=>createHash('sha256').update(value).digest('hex'),modules=new Map(),inputs=new Map();
function compile(source,loadDependency){
 const loadedModule={exports:{}};
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 new Function('require','module','exports',code)(loadDependency,loadedModule,loadedModule.exports);
 return loadedModule.exports;
}
function load(path){
 assert.ok(path.startsWith(web+sep),'Only checked-in web modules may be evaluated');
 if(modules.has(path))return modules.get(path);
 const raw=readFileSync(path),text=raw.toString('utf8');inputs.set(relative(root,path),{bytes:raw.byteLength,sha256:digest(raw)});
 const exported=path.endsWith('.json')?JSON.parse(text):compile(text,id=>{
  assert.ok(id.startsWith('./')||id.startsWith('../')||id.startsWith('@/'),'Unexpected nonlocal catalogue module');
  return load((id.startsWith('@/')?resolve(web,id.slice(2)):resolve(dirname(path),id))+(id.endsWith('.json')?'':'.ts'));
 });
 modules.set(path,exported);return exported;
}
const baselineSource=execFileSync('git',['show',`${options.baseline}:web/lib/search.ts`],{cwd:root,encoding:'utf8',maxBuffer:1024*1024});
const baseline=compile(baselineSource,()=>{throw new Error('Baseline search unexpectedly imports runtime dependencies');}).createSearchIndex;
const candidate=load(resolve(web,'lib/search.ts')).createSearchIndex;
const {searchDocuments}=load(resolve(web,'lib/site-search.ts'));
const {trails,regions}=load(resolve(web,'lib/content.ts'));
const {territories,trailBelongsToRegion,createTrailRegionIndex}=load(resolve(web,'lib/territories.ts'));
const queryCorpus=new Set(['',',fqrfk','Bzerpin','Мултинские озера','бзепринский','Байкал до 15 км','Кавказ на один день','несуществующий'.repeat(30)]);
for(const item of searchDocuments){
 queryCorpus.add(item.title);
 const first=item.title.split(/[\s—–]+/).find(word=>word.length>=4);
 if(first){queryCorpus.add(first);const at=Math.floor(first.length/2);queryCorpus.add(first.slice(0,at-1)+first[at]+first[at-1]+first.slice(at+1));}
 if(item.kind==='route'){queryCorpus.add(item.title+' до 15 км');if(item.duration)queryCorpus.add(item.title+' до 8 ч');}
}
const searchOptions=[{},{kind:'route'},{kind:'region'},{kind:'story'},{kind:'page'},{includeUnspecified:false}];
const expected=baseline(searchDocuments),actual=candidate(searchDocuments),responseHash=createHash('sha256');
let comparisons=0;
for(const query of queryCorpus){
 const option=searchOptions[comparisons%searchOptions.length],before=expected(query,option),after=actual(query,option);
 assert.deepEqual(after,before,`Search response changed for ${JSON.stringify({query,option})}`);
 responseHash.update(JSON.stringify(after));comparisons++;
}
const queries=['Байкал','Бзепринский','Мултинские озера','краснодарский край до 15 км','Хибины','Эльбрус на один день','байкальская тропа','сапфировая совершеннонесуществующий','место отдыха рядом с озером',',fqrfk','Bzerpin','Кавказ до 25 км до 8 ч','Верхнее Мультинское','гора','тр',''];
function measure(factory,documents){
 const start=performance.now(),search=factory(documents),buildMs=performance.now()-start,samples=[],replies=[];
 for(let repeat=0;repeat<5;repeat++)for(const query of queries){
  const begin=performance.now(),response=search(query);samples.push({query,ms:performance.now()-begin});if(!repeat)replies.push(response);
 }
 const times=samples.map(sample=>sample.ms).sort((a,b)=>a-b);
 return{replies,measurement:{buildMs,medianMs:times[Math.floor(times.length/2)],p95Ms:times[Math.floor(times.length*.95)],maxMs:times.at(-1),totalMs:times.reduce((sum,n)=>sum+n,0),samples:samples.length,firstPass:samples.slice(0,queries.length)}};
}
const searches=[];
for(const multiplier of [1,10]){
 const documents=Array.from({length:multiplier},(_,batch)=>searchDocuments.map(document=>({...document,id:`${batch}:${document.id}`}))).flat();
 const before=measure(baseline,documents),after=measure(candidate,documents);assert.deepEqual(after.replies,before.replies);
 searches.push({documents:documents.length,synthetic:multiplier!==1,multiplier,baseline:before.measurement,candidate:after.measurement,repliesEqual:true,repliesSha256:digest(JSON.stringify(after.replies))});
}
const memberships=[];
for(const multiplier of [1,10]){
 const catalogue=Array.from({length:multiplier},(_,batch)=>trails.map(trail=>({...trail,id:`${batch}:${trail.id}`}))).flat(),all=[...regions,...territories];
 const mean=(build)=>{let elapsed=0,result;for(let repeat=0;repeat<20;repeat++){const start=performance.now();result=build();elapsed+=performance.now()-start;}return{meanMs:elapsed/20,result};};
 const before=mean(()=>new Map(all.map(region=>[region.id,catalogue.filter(trail=>trailBelongsToRegion(trail,region))]))),after=mean(()=>createTrailRegionIndex(catalogue));
 for(const region of all)assert.deepEqual(after.result.get(region.id)??[],before.result.get(region.id),region.id);
 memberships.push({routes:catalogue.length,regions:all.length,synthetic:multiplier!==1,baselineMeanMs:before.meanMs,candidateMeanMs:after.meanMs,orderedMembershipEqual:true});
}
const report={schemaVersion:1,kind:'catalogue-node-diagnostic',diagnosticOnly:true,verified:false,releaseEligible:false,createdAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,baseline:{commit:options.baseline,searchSourceSha256:digest(baselineSource)},inputs:Object.fromEntries(inputs),catalogue:{routes:trails.length,documents:searchDocuments.length,directions:regions.length,territories:territories.length},semanticComparison:{queries:comparisons,options:searchOptions,fullResponseEqual:true,responseSha256:responseHash.digest('hex')},queries,searches,memberships,limitations:['Node microbenchmark, not browser interaction or physical-device performance.','Synthetic 10x input repeats current documents with unique IDs; it models shared vocabulary, not ten times as many independent places.','Five query passes include the bounded production token cache; firstPass is also retained.','No input, geometry, image quality, CLS or browser performance gate is changed.']};
const text=JSON.stringify(report,null,2)+'\n';
if(options.output)writeFileSync(resolve(options.output),text);
console.log(JSON.stringify({output:options.output,documents:searchDocuments.length,queries:comparisons,fullResponseEqual:true,searches:searches.map(({baseline,candidate,...rest})=>({...rest,baseline:{buildMs:baseline.buildMs,p95Ms:baseline.p95Ms},candidate:{buildMs:candidate.buildMs,p95Ms:candidate.p95Ms}})),memberships},null,2));
