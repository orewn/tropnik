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
