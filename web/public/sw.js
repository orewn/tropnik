/* Тропник. Only public static assets are cached. Auth, chat and API responses never enter CacheStorage. */
const VERSION='tropnik-shell-0.4.24-57184f6b1a935258';
const SHELL=["/maps/map-coverage-lod.js","/data/map-coverage/manifest.json","/data/map-coverage/base.coverage","/maps/russia-viewport.js","/data/russia-display-area.geojson","/data/russia-outside-mask.geojson","/data/russia-canonical-mask.geojson","/data/russia-boundaries-provenance.json","/offline-fonts.css","/fonts/MANROPE-LICENSE.txt","/fonts/manrope-latin-400.woff2","/fonts/manrope-cyrillic-400.woff2","/fonts/manrope-latin-600.woff2","/fonts/manrope-cyrillic-600.woff2","/offline-safety.html","/offline-safety.js","/offline-safety.css","/offline-viewer.html","/offline.js","/offline.css","/favicon.svg","/data/world.geojson","/data/regions.geojson","/data/territories.geojson"];
const MAP_WARM=['/terrain/ATTRIBUTION.txt','/terrain/sources/Copernicus-GLO30-LICENSE.pdf','/terrain/landscape.html'];
// BEGIN GENERATED CUSTOM MAP
const CUSTOM_MAP_RESOURCES=[{"path":"/custom-map/chunks/custom-map-entry-BnbG0QHr.js","sizeBytes":87843,"sha256":"d1ee3b91ece44aa7625e81fab66c15a24d46dc6c52d7501bc476b14507be7a89"},{"path":"/custom-map/chunks/terrain-renderer-pEGv39m9.js","sizeBytes":67253,"sha256":"310da5b0116577c1e0c787e545e281780d91c3c28b521da07cb9c5263c791f99"},{"path":"/custom-map/Manrope-OFL.txt","sizeBytes":4383,"sha256":"d826ab6583b12c26807d8716a545bdbbb672df04f48608a364ba9efdbe501c30"},{"path":"/custom-map/map-runtime.js","sizeBytes":156,"sha256":"cdbc14bf7990058f962efb96eb49399a1a1f65f7c7ca3252bd6ee356d94bb1b0"},{"path":"/custom-map/map.css","sizeBytes":74211,"sha256":"68c18850420cbb25449c3cea8b80c6eef0f016570b3bca93c19813573ff4c107"},{"path":"/custom-map/workers/custom-map-tiles.worker-DGlgeZtR.js","sizeBytes":23159,"sha256":"8d32e4d4733ad106784e2e4a497073954328c094fa28a972efa09a512656655d"},{"path":"/custom-map/workers/terrain-preparation.worker-B8lieq38.js","sizeBytes":2849,"sha256":"fb157dbeb3f394b9d9a3edd115cc30dc64f11e352255ca609a2191fa8be7ae0f"},{"path":"/custom-map/manifest.json","sizeBytes":341492,"sha256":"da50e45a1dc06620990a2901b1e402373eac8a1b906ed0f7682376a5a17ac6d3"}];
// END GENERATED CUSTOM MAP
const CUSTOM_MAP_URLS=new Set(CUSTOM_MAP_RESOURCES.map(file=>file.path));
const warmJobs=new Map();
const SAFETY_PAGES=['/safety/registration','/safety/registration/','/offline-safety','/offline-safety.html'];
const COVERAGE_CELLS='/data/map-coverage/cells/';
const COVERAGE_CACHE_LIMITS={bytes:32*1024*1024,entries:64,cellBytes:3*1024*1024};
let coverageWrites=Promise.resolve();
function coverageCell(path){return path.startsWith(COVERAGE_CELLS)&&/^[a-z0-9_-]+\.coverage$/i.test(path.slice(COVERAGE_CELLS.length));}
function rememberCoverage(cache,path,response){
 const job=coverageWrites.then(async()=>{
  if(Number(response.headers.get('content-length'))>COVERAGE_CACHE_LIMITS.cellBytes){response.body?.cancel().catch(()=>{});return;}
  const reader=response.body?.getReader();if(!reader)return;
  const parts=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>COVERAGE_CACHE_LIMITS.cellBytes){reader.cancel().catch(()=>{});return;}parts.push(value);}}finally{reader.releaseLock();}
  if(!size)return;
  const retained=[];let total=0;
  for(const request of await cache.keys()){
   if(!coverageCell(new URL(request.url).pathname))continue;
   if(new URL(request.url).pathname===path){await cache.delete(request);continue;}
   const cached=await cache.match(request),bytes=Number(cached?.headers.get('x-tropnik-coverage-bytes'));
   if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>COVERAGE_CACHE_LIMITS.cellBytes){await cache.delete(request);continue;}
   retained.push({request,bytes});total+=bytes;
  }
  while(retained.length&&(retained.length>=COVERAGE_CACHE_LIMITS.entries||total+size>COVERAGE_CACHE_LIMITS.bytes)){const old=retained.shift();await cache.delete(old.request);total-=old.bytes;}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  await cache.put(path,new Response(bytes,{headers:{'Content-Type':response.headers.get('Content-Type')||'application/json','X-Tropnik-Coverage-Bytes':String(size)}}));
 });
 // Cache pressure must never turn a successful map download into an error.
 coverageWrites=job.catch(()=>{});return coverageWrites;
}
async function coverageResponse(request,url){
 if(request.cache==='no-store'||request.cache==='reload')return{response:await fetch(request)};
 const cache=await caches.open(VERSION),found=await cache.match(url.pathname);
 if(found)return{response:found};
 const response=await fetch(request);
 const write=response.ok&&response.type==='basic'?rememberCoverage(cache,url.pathname,response.clone()):undefined;
 return{response,write};
}
async function cacheOverview(cache){
 const base='/maps/russia-relief/',response=await fetch(base+'manifest.json',{cache:'no-store'});
 if(!response.ok)throw new Error('Overview manifest unavailable');
 const manifestText=await response.text();let manifest;
 try{manifest=JSON.parse(manifestText);}catch{throw new Error('Invalid overview package');}
 if(!manifest.complete||manifest.tileCount!==341||manifest.files?.length!==341||manifest.totalTileBytes>3*1024*1024)throw new Error('Invalid overview package');
 const seen=new Set(),unique=new Map();let total=0;
 for(const file of manifest.files){
  const match=/^([0-4])\/(\d+)\/(\d+)\.png$/.exec(file.path);
  if(!match||file.path!==`${+match[1]}/${+match[2]}/${+match[3]}.png`||+match[2]>=2**+match[1]||+match[3]>=2**+match[1]||seen.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>524288||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Invalid overview tile');
  seen.add(file.path);total+=file.bytes;if(total>3*1024*1024)throw new Error('Overview byte budget exceeded');
  if(!unique.has(file.sha256))unique.set(file.sha256,{file,paths:[]});
  if(unique.get(file.sha256).file.bytes!==file.bytes)throw new Error('Conflicting overview tile');
  unique.get(file.sha256).paths.push(file.path);
 }
 if(total!==manifest.totalTileBytes)throw new Error('Overview package size mismatch');
 const pending=[...unique.values()];let index=0;
 await Promise.all(Array.from({length:3},async()=>{
  while(index<pending.length){
   const {file,paths}=pending[index++],result=await fetch(base+file.path);
   if(!result.ok)throw new Error('Overview tile unavailable');
   const bytes=await result.arrayBuffer();
   const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
   if(bytes.byteLength!==file.bytes||hash!==file.sha256)throw new Error('Overview tile integrity mismatch');
   for(const path of paths)await cache.put(base+path,new Response(bytes,{headers:{'Content-Type':'image/png'}}));
  }
 }));
 await cache.put(base+'manifest.json',new Response(manifestText,{headers:{'Content-Type':response.headers.get('Content-Type')||'application/json'}}));
 await cache.addAll([base+'tilejson.json',base+'ATTRIBUTION.txt']);
}
async function cacheCustomMapRuntime(cache){
 if(!CUSTOM_MAP_RESOURCES.length||CUSTOM_MAP_RESOURCES.length>64)throw new Error('Missing shared map shell');
 let index=0,total=0;
 await Promise.all(Array.from({length:3},async()=>{
  while(index<CUSTOM_MAP_RESOURCES.length){
   const file=CUSTOM_MAP_RESOURCES[index++];
   if(!file.path.startsWith('/custom-map/')||!Number.isSafeInteger(file.sizeBytes)||file.sizeBytes<=0||file.sizeBytes>2*1024*1024||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Invalid shared map shell');
   total+=file.sizeBytes;if(total>4*1024*1024)throw new Error('Shared map shell exceeds budget');
   const cached=await cache.match(file.path),response=cached||await fetch(file.path,{cache:'no-store',credentials:'omit'});
   if(!response.ok||(!cached&&response.type!=='basic'))throw new Error('Shared map runtime unavailable');
   const bytes=await response.arrayBuffer();
   const actual=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
   if(bytes.byteLength!==file.sizeBytes||actual!==file.sha256)throw new Error('Shared map runtime integrity mismatch');
   await cache.put(file.path,new Response(bytes,{headers:{'Content-Type':response.headers.get('Content-Type')||'application/octet-stream'}}));
  }
 }));
}
function warmMapCache(){
 const kind='canvas',marker=`/_offline/map-warm-${VERSION}-${kind}`;
 if(warmJobs.has(kind))return warmJobs.get(kind);
 const job=(async()=>{const cache=await caches.open(VERSION);if(await cache.match(marker))return;await cache.addAll(MAP_WARM);await cacheCustomMapRuntime(cache);await cacheOverview(cache);await cache.put(marker,new Response('ready',{headers:{'Content-Type':'text/plain'}}));})().catch(error=>{warmJobs.delete(kind);throw error;});
 warmJobs.set(kind,job);return job;
}
self.addEventListener('install',event=>{event.waitUntil((async()=>{const cache=await caches.open(VERSION);await Promise.all([cache.addAll(SHELL),cacheCustomMapRuntime(cache)]);})());});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('tropnik-shell-')&&name!==VERSION)await caches.delete(name);await self.clients.claim();})());});
self.addEventListener('message',event=>{if(event.data?.type==='skip-waiting')event.waitUntil(self.skipWaiting());else if(event.data?.type==='warm-map')event.waitUntil(warmMapCache(event.data.engine));});
async function verifiedResource(request){const names=(await caches.keys()).filter(n=>n.startsWith('tropnik-map-')).sort().reverse();for(const name of names){const cache=await caches.open(name);if(await cache.match('/_offline/verified-map')){const match=await cache.match(request);if(match)return match;}}return null;}
self.addEventListener('fetch',event=>{const req=event.request,url=new URL(req.url);if(req.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||req.headers.get('RSC'))return;
 if(coverageCell(url.pathname)){const result=coverageResponse(req,url);event.respondWith(result.then(value=>value.response));event.waitUntil(result.then(value=>value.write).catch(()=>{}));return;}
 if(url.pathname.startsWith('/offline-map/')){event.respondWith((async()=>{if(req.cache==='no-store'||req.cache==='reload')return fetch(req);const found=await verifiedResource(req);if(found)return found;return fetch(req);})());return;}
 if(req.mode==='navigate'){event.respondWith(fetch(req).catch(async()=>{const cache=await caches.open(VERSION);if(SAFETY_PAGES.includes(url.pathname))return await cache.match('/offline-safety.html')||Response.error();return await cache.match(url.pathname)||await cache.match('/offline-viewer.html')||Response.error();}));return;}
 const permitted=['/terrain/terrain-grid.json','/terrain/terrain-preview.json'].includes(url.pathname)||SHELL.includes(url.pathname)||MAP_WARM.includes(url.pathname)||CUSTOM_MAP_URLS.has(url.pathname)||url.pathname.startsWith('/_next/static/')||url.pathname.startsWith('/assets/')||url.pathname.startsWith('/data/routes/')||url.pathname.startsWith('/maps/russia-relief/');if(!permitted)return;
 event.respondWith((async()=>{const cache=await caches.open(VERSION);const found=await cache.match(req);if(found)return found;const res=await fetch(req);if(res.ok&&res.type==='basic')await cache.put(req,res.clone());return res;})());
});
