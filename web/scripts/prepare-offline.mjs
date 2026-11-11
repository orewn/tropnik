import {readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {verifyCustomMap} from './verify-custom-map.mjs';

// The committed vector and DEM archives are the build inputs. A Sites checkout
// contains only web/, so production builds must not read ../data or fetch tiles.
const root=new URL('../',import.meta.url);
const dest=new URL('public/offline-map/',root);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const scenePath='terrain/landscape.html';
const customMap=await verifyCustomMap();
function records(files,sizeKey){
 if(!Array.isArray(files)||!files.length||files.length>1000)throw new Error('Invalid offline archive file list');
 const found=new Map();
 for(const file of files){
  if(typeof file.path!=='string'||!/^\w[\w /.-]+$/.test(file.path)||file.path.split('/').some(part=>!part||part==='.'||part==='..')||found.has(file.path)||!Number.isSafeInteger(file[sizeKey])||file[sizeKey]<0||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Invalid offline archive record: '+file.path);
  found.set(file.path,file);
 }
 return found;
}

const manifest=JSON.parse(await readFile(new URL('manifest.json',dest),'utf8'));
if(!manifest.complete)throw new Error('Offline vector archive is incomplete');
const committed=records(manifest.files,'bytes');
// Only the embedded scene is generated. All original source records, tiles,
// licences must still match their committed byte lengths and hashes.
for(const [path,file] of committed){
 if(path===scenePath)continue;
 const bytes=await readFile(new URL(path,dest));
 if(bytes.length!==file.bytes||hash(bytes)!==file.sha256)throw new Error('Offline archive integrity check failed: '+path);
}
const terrainManifestPath='terrain/manifest.json';
if(!committed.has(terrainManifestPath))throw new Error('Verified DEM archive is missing');
const terrain=JSON.parse(await readFile(new URL(terrainManifestPath,dest),'utf8'));
if(!terrain.complete)throw new Error('Offline DEM archive is incomplete');
const terrainFiles=records(terrain.files,'sizeBytes');
for(const [path,file] of terrainFiles){
 const outer=committed.get('terrain/'+path);
 if(!outer||outer.bytes!==file.sizeBytes||outer.sha256!==file.sha256)throw new Error('DEM source manifest mismatch: '+path);
}
for(const path of committed.keys())if(path.startsWith('terrain/')&&path!==scenePath&&path!==terrainManifestPath&&!terrainFiles.has(path.slice('terrain/'.length)))throw new Error('Unlisted DEM archive resource: '+path);

const sourceManifestPath='source-manifest.json';
const sourceManifestBytes=await readFile(new URL(sourceManifestPath,dest));
const vectorSource=JSON.parse(sourceManifestBytes.toString('utf8'));
if(!vectorSource.complete||vectorSource.tileCount!==193)throw new Error('Original vector source archive is incomplete');
const vectorRecords=records(vectorSource.files,'bytes');
for(const [path,file] of vectorRecords){
 if(path.startsWith('fonts/'))continue;
 const actual=committed.get(path);
 if(!actual||actual.bytes!==file.bytes||actual.sha256!==file.sha256)throw new Error('Original vector source data changed: '+path);
}
const scene=await readFile(new URL('public/terrain/landscape.html',root));
const sceneHash=hash(scene);
delete manifest.builtAt;
for(const key of ['glyphRangesExpected','fontstack','localGlyphs'])delete manifest[key];
manifest.runtime='tropnik-canvas';
manifest.sourceArchive={manifestPath:sourceManifestPath,sha256:hash(sourceManifestBytes)};
manifest.ipRights=manifest.ipRights.filter(item=>!/glyph/i.test(item.component));
manifest.files=manifest.files.filter(file=>file.path!==scenePath&&file.path!==sourceManifestPath&&!file.path.startsWith('fonts/'));
manifest.files.push({path:sourceManifestPath,bytes:sourceManifestBytes.length,sha256:hash(sourceManifestBytes)});
manifest.files.push({path:scenePath,bytes:scene.length,sha256:sceneHash});
manifest.title='Бзерпинский район · карта и рельеф';
manifest.limitations='Bounded map and DEM only. No satellite imagery, live weather, live closures, field verification or guaranteed navigation accuracy. Offline changes never authorize a group start.';
manifest.terrainTileCount=terrain.tileCount;
manifest.terrainMaxzoom=terrain.maxzoom;
manifest.terrainSource=terrain.source;
manifest.totalFiles=manifest.files.length;
manifest.resourceBytes=manifest.files.reduce((sum,file)=>sum+file.bytes,0);
for(let attempt=0;attempt<10;attempt++){
 const total=manifest.resourceBytes+Buffer.byteLength(JSON.stringify(manifest));
 if(total===manifest.packageBytesIncludingManifest)break;
 manifest.packageBytesIncludingManifest=total;
 if(attempt===9)throw new Error('Offline manifest byte total did not converge');
}

// Validation precedes every output write; an invalid source archive fails closed.
await writeFile(new URL(scenePath,dest),scene);
await writeFile(new URL('manifest.json',dest),JSON.stringify(manifest));
await rm(new URL('fonts/',dest),{recursive:true,force:true});
// A reused checkout may contain generated vendor files from an older build.
// They are not loaded, copied or precached by the own map runtime.
for(const file of ['maplibre-gl.mjs','maplibre-gl.css','maplibre-worker.js','leaflet.js','leaflet.css','protomaps-leaflet.js','tropa-style.json','pilot-style.json','tropnik-sprite.png','tropnik-sprite.json','tropnik-sprite@2x.png','tropnik-sprite@2x.json'])await rm(new URL('public/maps/'+file,root),{force:true});
const shellFiles=[...customMap.files,customMap.manifest].map(file=>({path:'/custom-map/'+file.path,sizeBytes:file.sizeBytes,sha256:file.sha256}));
const workerURL=new URL('public/sw.js',root),worker=await readFile(workerURL,'utf8');
const start='// BEGIN GENERATED CUSTOM MAP',end='// END GENERATED CUSTOM MAP';
if(!worker.includes(start)||!worker.includes(end))throw new Error('Service worker shared-map boundary is missing');
await writeFile(workerURL,worker.slice(0,worker.indexOf(start))+start+'\nconst CUSTOM_MAP_RESOURCES='+JSON.stringify(shellFiles)+';\n'+end+worker.slice(worker.indexOf(end)+end.length));
console.log(JSON.stringify({files:manifest.totalFiles,vectorTiles:manifest.tileCount,terrainTiles:manifest.terrainTileCount,packageBytes:manifest.packageBytesIncludingManifest,landscapeBytes:scene.length,sharedMapFiles:shellFiles.length,sharedMapManifestSha256:customMap.manifestSha256,allArchiveHashesVerified:true,networkRequests:0}));
