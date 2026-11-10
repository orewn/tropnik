import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';

// Exercise the installed SDK offline. As in map-terrain-pitch.test.mjs, only
// browser capability detection is substituted; no DOM, WebGL or server runs.
const require=createRequire(new URL('../package.json',import.meta.url)),ts=require('typescript');
const sdk=dirname(require.resolve('maplibre-gl/package.json')),sdkRequire=createRequire(resolve(sdk,'package.json')),modules=new Map();
const compilerOptions={target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true,useDefineForClassFields:false};
function load(path){
 if(path.endsWith('/util/browser.ts'))return{browser:{prefersReducedMotion:false}};
 if(modules.has(path))return modules.get(path).exports;
 const loadedModule={exports:{}};modules.set(path,loadedModule);
 const compiled=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions}).outputText;
 new Function('require','module','exports',compiled)(id=>id.startsWith('.')?load(resolve(dirname(path),id)):sdkRequire(id),loadedModule,loadedModule.exports);
 return loadedModule.exports;
}
const {MercatorTransform}=load(resolve(sdk,'src/geo/projection/mercator_transform.ts'));
const {coveringTiles}=load(resolve(sdk,'src/geo/projection/covering_tiles.ts'));
const {VectorTileSource}=load(resolve(sdk,'src/source/vector_tile_source.ts'));
const {sliceVectorTileLayer}=load(resolve(sdk,'src/source/vector_tile_overzoomed.ts'));
const {CanonicalTileID}=load(resolve(sdk,'src/tile/tile_id.ts'));
const {LngLat}=load(resolve(sdk,'src/geo/lng_lat.ts'));
const {default:Point}=sdkRequire('@mapbox/point-geometry');

function parse(path){return ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true,path.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);}
function matching(root,predicate){const found=[];const visit=node=>{if(predicate(node))found.push(node);ts.forEachChild(node,visit);};visit(root);return found;}
function numericProperty(object,name){
 assert.ok(object&&ts.isObjectLiteralExpression(object),'Expected an options object');
 const entries=object.properties.filter(property=>ts.isPropertyAssignment(property)&&property.name.getText().replaceAll(/['"]/g,'')===name);
 assert.equal(entries.length,1,`Expected one explicit ${name} option`);
 assert.ok(ts.isNumericLiteral(entries[0].initializer),`${name} must be an explicit numeric option`);
 return Number(entries[0].initializer.text);
}
const atlas=parse(new URL('../components/Atlas.tsx',import.meta.url).pathname);
const constructors=matching(atlas,node=>ts.isNewExpression(node)&&node.expression.getText(atlas)==='ml.Map');
assert.equal(constructors.length,1,'Read the actual Atlas MapLibre constructor');
const mapOptions=constructors[0].arguments[0];
const application={maxZoom:numericProperty(mapOptions,'maxZoom'),zoomLevelsToOverscale:numericProperty(mapOptions,'zoomLevelsToOverscale')};
const sdkMap=parse(resolve(sdk,'src/ui/map.ts'));
const sdkDefaults=matching(sdkMap,node=>ts.isVariableDeclaration(node)&&node.name.getText(sdkMap)==='defaultOptions');
assert.equal(sdkDefaults.length,1);
const defaultOverscale=numericProperty(sdkDefaults[0].initializer,'zoomLevelsToOverscale');

// Loading the whole TileManager also imports the installed MLT package, whose
// extensionless ESM imports cannot run under this Node loader. Compile the
// unchanged SDK method from its AST instead of copying its canonical-cap math.
// Coverage and source requests are intercepted only after their real decisions.
function installedMethod(relativePath,className,methodName,dependencies={}){
 const source=parse(resolve(sdk,relativePath));
 const classes=matching(source,node=>ts.isClassDeclaration(node)&&node.name?.text===className);
 assert.equal(classes.length,1);
 const methods=classes[0].members.filter(node=>ts.isMethodDeclaration(node)&&node.name.getText(source)===methodName);
 assert.equal(methods.length,1);
 const code=`class InstalledMethod {${methods[0].getText(source)}}\nmodule.exports=InstalledMethod.prototype.${methodName};`;
 const compiled=ts.transpileModule(code,{compilerOptions}).outputText,loadedModule={exports:{}};
 new Function('module',...Object.keys(dependencies),compiled)(loadedModule,...Object.values(dependencies));
 return loadedModule.exports;
}
const stopCoverage=Symbol('coverage complete before tile loading');
let coverage;
const update=installedMethod('src/tile/tile_manager.ts','TileManager','update',{
 coveringTiles:(transform,options)=>{
  const tiles=coveringTiles(transform,options);coverage={options,tiles};throw stopCoverage;
 },
});
const workerLoadTile=installedMethod('src/source/vector_tile_worker_source.ts','VectorTileWorkerSource','loadTile');

function sourceFor(zoomLevelsToOverscale,transform){
 const source=new VectorTileSource('openmaptiles',{type:'vector'},undefined,undefined);
 // Fixed TileJSON fixture: data exists only through z14. Do not load a URL.
 source.maxzoom=14;source.tiles=['https://tiles.example.test/{z}/{x}/{y}.pbf'];
 source.map={_zoomLevelsToOverscale:zoomLevelsToOverscale,getPixelRatio:()=>1,
  style:{projection:{worldCoordinateHelper:transform.worldCoordinateHelper}},
  _requestManager:{transformRequest:(url)=>({url})}};
 return source;
}
function cover(zoom,zoomLevelsToOverscale,type='vector'){
 const transform=new MercatorTransform({maxZoom:application.maxZoom,minPitch:0,maxPitch:75,renderWorldCopies:true});
 transform.resize(1041,928);transform.setCenter(new LngLat(40.39729094372467,43.72871233957642));transform.setZoom(zoom);
 const vectorSource=sourceFor(zoomLevelsToOverscale,transform);
 const source=type==='vector'?vectorSource:{type,tileSize:512,minzoom:0,maxzoom:14,reparseOverscaled:false,roundZoom:true};
 const calls={cache:0,wrap:0,elevation:0};
 // TerrainTileManager uses a 2x visual tile size for DEM coverage. Keep that
 // existing rule in the comparison; the candidate only changes vector caps.
 const manager={_sourceLoaded:true,_paused:false,used:true,usedForTerrain:type==='raster-dem',tileSize:1024,_source:source,map:vectorSource.map,
  updateCacheSize:()=>{calls.cache++;},handleWrapJump:()=>{calls.wrap++;},_updateMaxContentElevation:()=>{calls.elevation++;return 0;}};
 coverage=undefined;
 assert.throws(()=>update.call(manager,transform),error=>error===stopCoverage,'Stop before tile loading, after computing real coverage');
 assert.deepEqual(calls,{cache:1,wrap:1,elevation:1});
 assert.ok(coverage.tiles.length>0,`Real coverage is nonempty at z${zoom}`);
 return{...coverage,source:vectorSource,transform};
}

test('Atlas vector slicing reaches canonical 17 while its native upper zoom stays 18',()=>{
 assert.deepEqual(application,{maxZoom:18,zoomLevelsToOverscale:1});
 const requested=[14,14.905,15,15.905,16,16.905,17,17.905,18],expected=[14,14,15,15,16,16,17,17,17];
 for(const [index,zoom] of requested.entries()){
  const result=cover(zoom,application.zoomLevelsToOverscale);
  assert.equal(result.transform.zoom,zoom,'The SDK camera still reaches the requested zoom');
  assert.deepEqual([...new Set(result.tiles.map(tile=>tile.canonical.z))],[expected[index]],`canonical coverage at z${zoom}`);
  assert.deepEqual([...new Set(result.tiles.map(tile=>tile.overscaledZ))],[Math.floor(zoom)],`overscaled coverage at z${zoom}`);
 }
});

test('the installed default keeps canonical 14 and the candidate does not change terrain DEM coverage',()=>{
 assert.equal(defaultOverscale,4,'Read the installed SDK default rather than duplicating it in the fixture');
 for(const zoom of [14,15,16,17,18]){
  const baseline=cover(zoom,defaultOverscale),dem=cover(zoom,application.zoomLevelsToOverscale,'raster-dem'),baselineDEM=cover(zoom,defaultOverscale,'raster-dem');
  assert.deepEqual([...new Set(baseline.tiles.map(tile=>tile.canonical.z))],[14],`default vector canonical coverage at z${zoom}`);
  assert.equal(dem.options.maxzoom,14,'The public vector option does not raise the DEM source cap');
  assert.deepEqual(dem.tiles.map(tile=>tile.key),baselineDEM.tiles.map(tile=>tile.key),`unchanged terrain DEM coverage at z${zoom}`);
 }
});

test('real vector overzoom parameters and worker request selection keep every upstream request at 14',async()=>{
 const stopRequest=Symbol('selected request before network');
 for(const zoomLevelsToOverscale of [defaultOverscale,application.zoomLevelsToOverscale])for(const zoom of [14,15,16,17,18]){
  const {tiles,source,transform}=cover(zoom,zoomLevelsToOverscale);
  for(const tileID of tiles){
   const overzoomParameters=await source._getOverzoomParameters({tileID});
   if(tileID.canonical.z===14)assert.equal(overzoomParameters,undefined,'Native z14 uses its original request');
   else assert.equal(overzoomParameters.maxZoomTileID.z,14,'A sliced child is generated from source maxzoom');
   const request={url:tileID.canonical.url(source.tiles,1,source.scheme,transform.worldCoordinateHelper.tileMatrixSet)};
   let selectedRequest,calls=0;
   await assert.rejects(workerLoadTile.call({_startRequestTiming:params=>{calls++;selectedRequest=params.request;throw stopRequest;}},
    {uid:'offline-test',tileID,request,overzoomParameters}),error=>error===stopRequest);
   assert.equal(calls,1,'Intercept the real worker method before any network operation');
   const expected=tileID.scaledTo(14).canonical;
   assert.equal(new URL(selectedRequest.url).pathname,`/14/${expected.x}/${expected.y}.pbf`);
  }
 }
});

test('installed vector slicing removes outside points, lines and polygons while retaining buffered edges and properties',()=>{
 const fixtures=[
  {id:1,type:1,properties:{name:'inside point'},geometry:[[[640,1152]]]},
  {id:2,type:1,properties:{name:'outside point'},geometry:[[[400,1152]]]},
  {id:3,type:1,properties:{name:'buffer point'},geometry:[[[500,1152]]]},
  {id:4,type:2,properties:{name:'crossing path',class:'path'},geometry:[[[400,1280],[1200,1280]]]},
  {id:5,type:2,properties:{name:'outside path'},geometry:[[[64,256],[128,256]]]},
  {id:6,type:3,properties:{name:'crossing meadow',class:'park'},geometry:[[[480,1088],[800,1088],[800,1472],[480,1472],[480,1088]]]},
  {id:7,type:3,properties:{name:'outside polygon'},geometry:[[[16,16],[64,16],[64,64],[16,64],[16,16]]]},
 ];
 const original=structuredClone(fixtures);
 const source={name:'synthetic-landscape',extent:4096,version:2,length:fixtures.length,feature:index=>{
  const fixture=fixtures[index];return{...fixture,extent:4096,loadGeometry:()=>fixture.geometry.map(ring=>ring.map(([x,y])=>new Point(x,y)))};
 }};
 const sliced=sliceVectorTileLayer(source,new CanonicalTileID(14,1000,6000),new CanonicalTileID(17,8001,48002));
 const features=Array.from({length:sliced.length},(_,index)=>sliced.feature(index)),byId=new Map(features.map(feature=>[feature.id,feature]));
 assert.equal(sliced.name,source.name);assert.equal(sliced.extent,4096);assert.equal(sliced.version,2);
 assert.deepEqual([...byId.keys()],[1,3,4,6],'Outside geometry is removed, including whole line and polygon features');
 const coordinates=feature=>feature.loadGeometry().map(ring=>ring.map(point=>[point.x,point.y]));
 assert.deepEqual(coordinates(byId.get(1)),[[[1024,1024]]]);
 assert.deepEqual(coordinates(byId.get(3)),[[[-96,1024]]],'The documented buffer preserves near-edge symbols');
 assert.deepEqual(coordinates(byId.get(4)),[[[-128,2048],[4224,2048]]],'Line endpoints clip to the buffered child tile');
 const polygon=coordinates(byId.get(6));
 assert.equal(polygon.length,1);assert.deepEqual(polygon[0][0],polygon[0].at(-1),'A clipped polygon remains closed');
 assert.ok(polygon[0].some(([x])=>x===-128),'The crossing polygon is clipped at the buffered edge');
 for(const feature of features){
  const originalFeature=fixtures.find(item=>item.id===feature.id);
  assert.equal(feature.type,originalFeature.type);assert.deepEqual(feature.properties,originalFeature.properties);assert.equal(feature.extent,4096);
  for(const ring of feature.loadGeometry())for(const point of ring)assert.ok(point.x>=-128&&point.x<=4224&&point.y>=-128&&point.y<=4224);
 }
 const returned=byId.get(1).loadGeometry();returned[0][0].x=-9999;
 assert.deepEqual(coordinates(byId.get(1)),[[[1024,1024]]],'Returned geometry is a fresh copy');
 assert.deepEqual(fixtures,original,'Slicing does not mutate the fixture source geometry or attributes');
});
