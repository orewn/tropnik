import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// The committed vector and DEM archives are the build inputs. A Sites checkout
// contains only web/, so production builds must not read ../data or fetch tiles.
const root=new URL('../',import.meta.url);
const dest=new URL('public/offline-map/',root);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const scenePath='terrain/landscape.html';
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
// glyphs and licences must still match their committed byte lengths and hashes.
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

const scene=await readFile(new URL('public/terrain/landscape.html',root));
const sceneHash=hash(scene);
if(committed.get(scenePath)?.sha256!==sceneHash)manifest.builtAt=new Date().toISOString();
manifest.files=manifest.files.filter(file=>file.path!==scenePath);
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

const source=JSON.parse(await readFile(new URL('public/maps/tropa-style.json',root),'utf8'));
source.name='Тропник · Бзерпин · офлайн';
source.glyphs='/offline-map/fonts/{fontstack}/{range}.pbf';
source.sources.openmaptiles={type:'vector',tiles:['/offline-map/localtiles/{z}/{x}/{y}.pbf'],minzoom:manifest.minzoom,maxzoom:manifest.maxzoom,bounds:manifest.bbox,attribution:'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors'};
for(const id of ['terrain-dem','hillshade-dem'])source.sources[id]={type:'raster-dem',tiles:['/offline-map/terrain/tiles/{z}/{x}/{y}.png'],minzoom:terrain.minzoom,maxzoom:terrain.maxzoom,tileSize:terrain.tileSize,encoding:terrain.encoding,bounds:terrain.bounds,attribution:'Terrain © Mapterhorn · Copernicus WorldDEM-30 · see /sources'};
source.terrain={source:'terrain-dem',exaggeration:1};
// Validation precedes every output write; an invalid source archive fails closed.
await writeFile(new URL(scenePath,dest),scene);
await writeFile(new URL('manifest.json',dest),JSON.stringify(manifest));
await writeFile(new URL('public/maps/pilot-style.json',root),JSON.stringify(source));
for(const file of ['maplibre-gl.mjs','maplibre-gl.css'])await copyFile(new URL('node_modules/maplibre-gl/dist/'+file,root),new URL('public/maps/'+file,root));
for(const [from,to] of [['leaflet/dist/leaflet.js','leaflet.js'],['leaflet/dist/leaflet.css','leaflet.css'],['protomaps-leaflet/dist/protomaps-leaflet.js','protomaps-leaflet.js'],['leaflet/LICENSE','LEAFLET-LICENSE.txt'],['protomaps-leaflet/LICENSE','PROTOMAPS-LEAFLET-LICENSE.txt']])await copyFile(new URL('node_modules/'+from,root),new URL('public/maps/'+to,root));
console.log(JSON.stringify({files:manifest.totalFiles,vectorTiles:manifest.tileCount,terrainTiles:manifest.terrainTileCount,packageBytes:manifest.packageBytesIncludingManifest,landscapeBytes:scene.length,allArchiveHashesVerified:true,networkRequests:0}));
