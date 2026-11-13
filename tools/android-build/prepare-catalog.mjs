import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,rename,readdir,access} from 'node:fs/promises';
import {dirname,join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeCatalogueRegions} from './catalog-regions.mjs';
import {nativeGeometryProvenance} from './catalog-provenance.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(join(root,'web/package.json'));
const ts=require('typescript');
const check=process.argv.includes('--check');
const assets=join(root,'android/app/src/main/assets');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const inputRecords=[];
async function input(path){
  const bytes=await readFile(path),record={path:relative(root,path),bytes:bytes.length,sha256:sha(bytes)};
  const prior=inputRecords.find(value=>value.path===record.path);
  if(prior&&(prior.bytes!==record.bytes||prior.sha256!==record.sha256))throw new Error(`Catalogue input changed while reading: ${record.path}`);
  if(!prior)inputRecords.push(record);
  return bytes;
}
async function output(path,bytes){
  const old=await readFile(path).catch(()=>null);if(old?.equals(bytes))return;
  if(check)throw new Error(`Generated native catalog asset is stale: ${relative(root,path)}`);
  await mkdir(dirname(path),{recursive:true});await writeFile(path+'.catalog-tmp',bytes);await rename(path+'.catalog-tmp',path);
}
await input(fileURLToPath(import.meta.url));
await input(join(root,'tools/android-build/catalog-regions.mjs'));
await input(join(root,'tools/android-build/catalog-provenance.mjs'));

// Compile the real exports, including geographic exclusions, rather than keeping
// a second manually maintained list of cards or region centres.
const contentPath=join(root,'web/lib/content.ts');
let code=(await input(contentPath)).toString('utf8');
const ast=ts.createSourceFile(contentPath,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const edits=[];
for(const node of ast.statements){
  if(!ts.isImportDeclaration(node)||node.importClause?.isTypeOnly)continue;
  const specifier=node.moduleSpecifier.text;
  if(!specifier.endsWith('.json')||!node.importClause?.name||node.importClause.namedBindings)throw new Error(`Unexpected content runtime import ${specifier}`);
  const path=specifier.startsWith('@/')?resolve(root,'web',specifier.slice(2)):resolve(dirname(contentPath),specifier);
  if(!path.startsWith(join(root,'web')+'/'))throw new Error('Content import escaped the web source');
  const value=JSON.parse((await input(path)).toString('utf8'));
  edits.push([node.getStart(ast),node.end,`const ${node.importClause.name.text}=${JSON.stringify(value)};`]);
}
for(const[start,end,value]of edits.sort((a,b)=>b[0]-a[0]))code=code.slice(0,start)+value+code.slice(end);
const compiled=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {regions:curatedRegions,trails}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const territoryRecords=JSON.parse((await input(join(root,'web/lib/territories.generated.json'))).toString('utf8')).territories;
const {regions,memberships:routeMemberships}=nativeCatalogueRegions(curatedRegions,territoryRecords,trails);
const coverage=JSON.parse(await readFile(join(root,'web/public/data/russia-boundaries-provenance.json'),'utf8'));
const excluded=new Set(coverage.excludedCatalogRouteIds);
if(!regions.length||regions.length>200||!trails.length||trails.length>100000)throw new Error('Web catalog cardinality is outside the reviewed import budget');
if(new Set(trails.map(t=>t.id)).size!==trails.length||trails.some(t=>excluded.has(t.id)))throw new Error('Duplicate or excluded route in native import');
const regionIds=new Set(regions.map(r=>r.id));
if(regionIds.size!==regions.length||regions.some(region=>!/^(?:[a-z0-9-]{1,64}|territory-[A-Za-z0-9]{1,54})$/.test(region.id)||!Array.isArray(region.center)||region.center.length!==2||!region.center.every(Number.isFinite)))throw new Error('Invalid catalogue region identity or overview centre');
const learning=JSON.parse((await input(join(root,'tools/android-build/fixtures/learning-route.json'))).toString('utf8'));
if(learning.id!=='learning-route'||!learning.illustrative||learning.geometryAsset)throw new Error('Learning card must remain explicitly illustrative and geometry-free');

const geometries=[];
const referenceOnlyRouteIds=[];
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const routes=[];
for(const trail of trails){
  if(trail.publicationStatus!=='reference')throw new Error(`Bundled import must not silently change publication semantics: ${trail.id}`);
  if(!/^[a-z0-9-]+$/.test(trail.id)||!regionIds.has(trail.regionId))throw new Error(`Invalid route identity ${trail.id}`);
  const memberships=routeMemberships.get(trail.id);
  if(memberships.some(id=>!regionIds.has(id)))throw new Error('Unknown region membership');
  let geometryAsset=null;
  if(trail.geometryUrl!==undefined&&trail.geometryUrl!==null){
    if(typeof trail.geometryUrl!=='string'||!/^\/data\/(?:routes|imported)\/[a-z0-9-]+\.geojson$/.test(trail.geometryUrl))throw new Error(`Unsupported route geometry path: ${trail.id}`);
    const sourcePath='web/public'+trail.geometryUrl;
    const bytes=await readFile(join(root,sourcePath));
    const geometry=JSON.parse(bytes.toString('utf8'));
    if(!['FeatureCollection','Feature','MultiLineString','LineString'].includes(geometry.type))throw new Error('Unexpected reference geometry type');
    geometryAsset=trail.id==='kavkaz-8a'?'maps/routes/route-11566519.geojson':`maps/routes/${trail.id}.geojson`;
    geometries.push({routeId:trail.id,path:geometryAsset,sourcePath,bytes:bytes.length,sha256:sha(bytes),data:bytes});
  }else{
    if(trail.geometry!=null||trail.center!=null||trail.bbox!=null||trail.geometryLengthKm!=null)throw new Error(`Reference without a geometry source cannot claim a route location: ${trail.id}`);
    referenceOnlyRouteIds.push(trail.id);
  }
  const notice=trail.operatingNotice;
  const distance=finite(trail.distanceKm);
  routes.push({id:trail.id,regionId:trail.regionId,regionIds:memberships,title:trail.title,
    summary:notice?.body||trail.subtitle,description:trail.description,difficulty:trail.difficultyLabel,
    difficultyCode:trail.difficulty,distanceMeters:distance===null?null:distance*1000,
    ascentMeters:finite(trail.ascentM),durationMinutes:null,durationText:trail.duration??null,
    geometryAsset,illustrative:false,fieldVerified:false,navigationReady:false,
    sourceName:trail.sourceName,sourceUrl:trail.sourceUrl,
    sourceTitle:trail.sourceTitle??null,distanceNote:trail.distanceNote??null,accessStatus:trail.accessStatus??null,
    territoryIds:memberships.filter(id=>id.startsWith('territory-')),
    ...nativeGeometryProvenance(trail,Boolean(geometryAsset)),
    sourceDate:trail.checkedAt,sourceKind:trail.sourceKind??null,publicationStatus:trail.publicationStatus,
    additionalSources:trail.additionalSources??[],
    currentStatusLabel:notice?.title??null,currentAdvisory:notice?.body??null,
    advisorySourceUrl:notice?.url??null,operatingNotice:notice??null,
    officialEvidence:trail.officialEvidence??null,
    officialEvidenceUrl:trail.officialEvidence?.url??null,
    officialEvidenceSummary:trail.officialEvidence?.summary??null,
    officialEvidenceScope:trail.officialEvidence?.scope??null,
    officialEvidenceCheckedAt:trail.officialEvidence?.checkedAt??null,
    notices:[...trail.notes],season:trail.season,
    sourceTechnicalDifficulty:trail.sourceTechnicalDifficulty??null,
    geometryLengthKm:trail.geometryLengthKm??null,center:trail.center??null,bbox:trail.bbox??null,
    osmId:trail.osmId??null});
}
routes.push({...learning,regionIds:[learning.regionId],navigationReady:false});
// One lossless overview for the shared loader; detailed source files above are
// reused through aliases rather than copied into a second catalogue package.
const overlayMetadata=JSON.parse((await input(join(root,'web/lib/trail-overlay.generated.json'))).toString('utf8'));
if(overlayMetadata.version!==1||!/^\/data\/trail-overlay-[a-f0-9]{16}\.json$/.test(overlayMetadata.url)||
  overlayMetadata.url!==`/data/trail-overlay-${overlayMetadata.sha256.slice(0,16)}.json`)throw new Error('Invalid trail overlay source');
const overlaySourcePath='web/public'+overlayMetadata.url;
const overlayBytes=await input(join(root,overlaySourcePath));
if(overlayBytes.length!==overlayMetadata.bytes||sha(overlayBytes)!==overlayMetadata.sha256||overlayBytes.length>8*1024*1024)throw new Error('Trail overlay integrity or resource budget differs');
const sourceKeys=new Set();
for(const geometry of geometries){
  const key=geometry.sourcePath.slice('web/public/data/'.length);sourceKeys.add(key);
  if(overlayMetadata.sourceHashes[key]!==geometry.sha256)throw new Error('Native trail source differs from the shared overlay: '+key);
}
if(sourceKeys.size!==Object.keys(overlayMetadata.sourceHashes).length||overlayMetadata.catalogueRoutes!==trails.length||
  overlayMetadata.geometryRoutes!==geometries.length||overlayMetadata.uniqueGeometries!==sourceKeys.size)throw new Error('Native/shared trail catalogue parity differs');
const trailOverlay={path:'maps/catalogue/trail-overlay.json',sourcePath:overlaySourcePath,url:overlayMetadata.url,
  bytes:overlayBytes.length,sha256:sha(overlayBytes),sourceCount:sourceKeys.size};
const identity=sha(JSON.stringify({inputs:inputRecords,geometry:geometries.map(({data,...record})=>record)}));
const catalog={schemaVersion:1,version:`web-catalog-${identity.slice(0,16)}`,
  regions:regions.map(region=>({id:region.id,name:region.name,subtitle:region.caption,description:region.description,
    latitude:region.center[1],longitude:region.center[0],zoom:region.zoom,territory:region.territory})),routes};
const catalogBytes=json(catalog);
const manifest={schemaVersion:1,id:'tropnik-reference-catalog-v1',catalog:{path:'catalog.json',bytes:catalogBytes.length,sha256:sha(catalogBytes)},
  sourceInputs:inputRecords,regionIds:[...regionIds],referenceRouteIds:trails.map(t=>t.id),learningRouteIds:[learning.id],
  geometryRouteIds:geometries.map(record=>record.routeId),referenceOnlyRouteIds,
  excludedRouteIds:[...excluded],fieldVerifiedCount:0,navigationReadyCount:0,
  trailOverlay,files:geometries.map(({data,...record})=>record)};
const expectedNames=new Set(geometries.map(record=>record.path.split('/').at(-1)));
const routeDirectory=join(assets,'maps/routes');
if(await access(routeDirectory).then(()=>true,()=>false))for(const entry of await readdir(routeDirectory)){
  if(entry.endsWith('.geojson')&&!expectedNames.has(entry))throw new Error(`Unexpected unmanaged geometry in native assets: ${entry}`);
}
for(const geometry of geometries)await output(join(assets,geometry.path),geometry.data);
await output(join(assets,trailOverlay.path),overlayBytes);
await output(join(assets,'catalog.json'),catalogBytes);
await output(join(assets,'catalog-manifest.json'),json(manifest));
const byRegion=Object.fromEntries([...regionIds].map(id=>[id,trails.filter(t=>routeMemberships.get(t.id).includes(id)).length]));
console.log(JSON.stringify({checked:check,regions:regions.length,referenceRoutes:trails.length,learningRoutes:1,
  geometryFiles:geometries.length,geometryBytes:geometries.reduce((sum,g)=>sum+g.bytes,0),
  referenceOnlyRoutes:referenceOnlyRouteIds.length,trailOverlayBytes:overlayBytes.length,trailOverlaySources:sourceKeys.size,
  catalogBytes:catalogBytes.length,catalogSha256:manifest.catalog.sha256,byRegion,
  excludedRouteIds:manifest.excludedRouteIds,fieldVerified:0,navigationReady:0},null,2));
