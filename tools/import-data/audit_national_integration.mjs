import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(resolve(root,'web/package.json'));
const ts=require('typescript');
const baseline='169b0bee9b2bbdb45adfbe71f4162f35f37344d1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=path=>readFileSync(resolve(root,path));
const previous=path=>execFileSync('git',['show',`${baseline}:${path}`],{cwd:root,maxBuffer:16_000_000});

function catalogue(readSource){
  const path='web/lib/content.ts', source=readSource(path).toString('utf8');
  const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const imports=new Map();
  for(const node of ast.statements){
    if(!ts.isImportDeclaration(node)||node.importClause?.isTypeOnly)continue;
    const id=node.moduleSpecifier.text;
    assert.ok(id.endsWith('.json'),'Only reviewed static JSON imports belong in the catalogue');
    const relative=id.startsWith('@/')?'web/'+id.slice(2):'web/lib/'+id.replace(/^\.\//,'');
    assert.ok(!relative.split('/').includes('..'));
    imports.set(id,JSON.parse(readSource(relative)));
  }
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports',code)(id=>{
    assert.ok(imports.has(id),'Unexpected runtime catalogue import');return imports.get(id);
  },module,module.exports);
  return module.exports;
}

const before=catalogue(previous), after=catalogue(read);
assert.equal(before.trails.length,306,'The baseline must be the actually published 0.4.23 catalogue');
const current=new Map(after.trails.map(route=>[route.id,route]));
assert.equal(current.size,after.trails.length,'Published route identities must be unique');
const geometryPath=url=>{
  assert.match(url,/^\/data\/(routes|imported)\/[a-z0-9-]+\.geojson$/);return 'web/public'+url;
};
const preserved=[];
for(const route of before.trails){
  const next=current.get(route.id);
  assert.ok(next,`Previously active route removed: ${route.id}`);
  assert.equal(next.checkedAt,route.checkedAt,`Historical source date changed: ${route.id}`);
  assert.equal(next.geometryUrl,route.geometryUrl,`Historical geometry URL changed: ${route.id}`);
  if(route.geometryUrl){
    const path=geometryPath(route.geometryUrl), original=previous(path), actual=read(path);
    assert.ok(actual.equals(original),`Historical active geometry bytes changed: ${path}`);
    preserved.push({id:route.id,path,bytes:actual.length,sha256:sha(actual)});
  }
}
assert.equal(preserved.length,277);
const oldTerritories=JSON.parse(previous('web/lib/territories.generated.json'));
const territories=JSON.parse(read('web/lib/territories.generated.json'));
const stripMembership=index=>{
  const copy=structuredClone(index);
  for(const row of copy.territories)delete row.geometryUrls;
  for(const key of ['routeGeometrySourceCount','routeGeometryMatchedCount','routeGeometryUnmatchedUrls','routeGeometrySources'])delete copy.metadata[key];
  return copy;
};
assert.deepEqual(stripMembership(territories),stripMembership(oldTerritories),'Territory identity, source, geometry, anchors or outlines changed');
assert.ok(read('web/public/data/territories.geojson').equals(previous('web/public/data/territories.geojson')),'Territory geometry bytes changed');
const ids=new Set([...after.regions.map(r=>r.id),...territories.territories.map(r=>r.id)]);
for(const route of after.trails){
  assert.ok(ids.has(route.regionId),`Unknown primary geographic identity: ${route.id}`);
  assert.ok((route.territoryIds??[]).every(id=>territories.territories.some(t=>t.id===id)),`Unknown territory: ${route.id}`);
  if(route.geometryUrl)assert.ok(existsSync(resolve(root,geometryPath(route.geometryUrl))),`Missing displayed geometry: ${route.id}`);
}
const supplement=JSON.parse(read('data/catalog/national/routes.json')).routes;
for(const route of supplement)assert.ok(current.has(route.id),`Acquired route was lost before publication: ${route.id}`);
const removedOrphans=['12804258','2512647'].map(id=>`web/public/data/imported/osm-relation-${id}.geojson`);
for(const path of removedOrphans){assert.ok(previous(path).length>0);assert.equal(existsSync(resolve(root,path)),false,`Unreferenced foreign geometry regenerated: ${path}`);}

function coverage(trails,index){
  return new Map(index.territories.map(territory=>{
    const urls=new Set(territory.geometryUrls);
    const members=trails.filter(route=>route.regionId===territory.id||route.regionIds?.includes(territory.id)||route.territoryIds?.includes(territory.id)||urls.has(route.geometryUrl));
    return [territory.id,{cards:members.length,geometry:members.filter(r=>r.geometryUrl).length}];
  }));
}
const oldCounts=coverage(before.trails,oldTerritories), newCounts=coverage(after.trails,territories);
const regionRows=territories.territories.map(t=>({id:t.id,name:t.name,before:oldCounts.get(t.id),after:newCounts.get(t.id)}));
const result={schemaVersion:1,auditedAt:new Date().toISOString(),status:'passed',baselineCommit:baseline,
  before:{cards:before.trails.length,geometry:preserved.length,territoriesWithCards:regionRows.filter(r=>r.before.cards).length,territoriesWithGeometry:regionRows.filter(r=>r.before.geometry).length},
  after:{cards:after.trails.length,geometry:after.trails.filter(r=>r.geometryUrl).length,territoriesWithCards:regionRows.filter(r=>r.after.cards).length,territoriesWithGeometry:regionRows.filter(r=>r.after.geometry).length},
  nationalSourceGeometryRoutes:supplement.length,oldActiveRoutesRetained:true,oldSourceDatesRetained:true,
  oldActiveGeometryBytesRetained:true,territoryGeometryAndOutlinesRetained:true,removedUnreferencedForeignGeometry:removedOrphans,
  sourceContentSha256:sha(read('web/lib/content.ts')),catalogueSha256:sha(read('web/lib/catalog.generated.json')),
  pointsSha256:sha(read('web/lib/route-points.generated.json')),territoryMetadataSha256:sha(read('web/lib/territories.generated.json')),
  territoryGeometrySha256:sha(read('web/public/data/territories.geojson')),regions:regionRows,
  zeroCardTerritories:regionRows.filter(r=>!r.after.cards).map(({id,name})=>({id,name})),preservedActiveGeometry:preserved,
  scope:'Actual exported catalogue coverage against the existing 85 display territories. Source geometry and reference cards are not field or current-access verification.'};
const destination=resolve(root,'data/catalog/national/web-integration-audit.json');
if(process.argv.includes('--check')){
  const old=JSON.parse(readFileSync(destination));delete old.auditedAt;
  const stable=structuredClone(result);delete stable.auditedAt;
  assert.deepEqual(stable,old,'The dated integration receipt is stale');
}else writeFileSync(destination,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({before:result.before,after:result.after,newGeometry:supplement.length,zeroCardTerritories:result.zeroCardTerritories,oldActiveGeometryBytesRetained:true}));
