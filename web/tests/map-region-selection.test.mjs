import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const web=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(resolve(web,'package.json')),ts=require('typescript'),cache=new Map();
function load(path){
  assert.ok(path.startsWith(web+sep));
  if(cache.has(path))return cache.get(path);
  if(path.endsWith('.json'))return JSON.parse(readFileSync(path,'utf8'));
  const loadedModule={exports:{}};
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  new Function('require','module','exports',code)(id=>load((id.startsWith('@/')?resolve(web,id.slice(2)):resolve(dirname(path),id))+(id.endsWith('.json')?'':'.ts')),loadedModule,loadedModule.exports);
  cache.set(path,loadedModule.exports);return loadedModule.exports;
}
const {territoryForMapPoint,territoriesForShapes}=load(resolve(web,'lib/territories.ts'));

test('a rendered administrative shape resolves to its exact territory',()=>{
  const candidates=territoriesForShapes(['Moscow']);
  assert.equal(candidates.length,1);
  assert.equal(territoryForMapPoint(['Moscow'],[37.62,55.75])?.id,candidates[0].id);
});

test('renderer order cannot change a multi-feature click result',()=>{
  const names=['Moscow Oblast','Moscow'];
  const forward=territoryForMapPoint(names,[37.62,55.75]);
  const reverse=territoryForMapPoint([...names].reverse(),[37.62,55.75]);
  assert.equal(forward?.id,reverse?.id);
  assert.ok(forward?.shapeNames.includes('Moscow'));
});

test('the smallest containing territory wins over a surrounding territory',()=>{
  const selected=territoryForMapPoint(['Moscow Oblast','Moscow'],[37.62,55.75]);
  assert.ok(selected);
  assert.ok(selected.shapeNames.includes('Moscow'));
});

test('unknown renderer properties never select a random territory',()=>{
  assert.equal(territoryForMapPoint(['__missing__'],[40,55]),undefined);
});

const {regions,trails}=load(resolve(web,'lib/content.ts'));
const {territories,trailBelongsToRegion,createTrailRegionIndex,mapRegionById}=load(resolve(web,'lib/territories.ts'));
test('the catalogue membership index preserves every route and order for all directions and territories',()=>{
 const index=createTrailRegionIndex(trails);
 for(const region of [...regions,...territories]){
  const expected=trails.filter(trail=>trailBelongsToRegion(trail,region));
  assert.deepEqual(index.get(region.id)??[],expected,region.name);
  for(let i=0;i<expected.length;i++)assert.equal(index.get(region.id)[i],expected[i],'map and cards retain the same objects');
 }
});

test('every shipped route has a resolvable primary place and preserves exact territory identities',()=>{
 const knownTerritories=new Set(territories.map(region=>region.id));
 for(const trail of trails){
  assert.ok(mapRegionById(trail.regionId),`unreachable primary region for ${trail.id}: ${trail.regionId}`);
  for(const id of trail.regionIds??[])assert.ok(mapRegionById(id),`unknown place membership for ${trail.id}: ${id}`);
  for(const id of trail.territoryIds??[])assert.ok(knownTerritories.has(id),`unknown territory membership for ${trail.id}: ${id}`);
  if(trail.regionIds?.length)assert.ok(trail.regionIds.includes(trail.regionId),`primary region omitted from declared memberships: ${trail.id}`);
 }
});

test('new territory routes resolve without inventing an editorial direction or geography',()=>{
 const first=territories.find(region=>region.shapeNames.includes('Moscow'));
 const second=territories.find(region=>region.shapeNames.includes('Moscow Oblast'));
 assert.ok(first&&second);
 const record={...trails[0],id:'national-fixture',regionId:first.id,regionIds:[first.id,first.id],territoryIds:[first.id,second.id,second.id],geometryUrl:undefined};
 const before=createTrailRegionIndex([record]);
 assert.equal(mapRegionById(first.id),first);
 assert.deepEqual(before.get(first.id),[record]);
 assert.deepEqual(before.get(second.id),[record]);
 const revised={...record,regionId:'baikal',regionIds:[],territoryIds:[]};
 const after=createTrailRegionIndex([revised]);
 assert.deepEqual([...after.keys()],['baikal'],'a tourism group alone cannot infer administrative membership');
 assert.deepEqual(before.get(first.id),[record],'a new catalogue cannot mutate its preceding revision');
 assert.equal(mapRegionById('baikal'),regions.find(region=>region.id==='baikal'));
 assert.equal(mapRegionById('__unknown__'),undefined);
});
