/* Тропник. Only public static assets are cached. Auth, chat and API responses never enter CacheStorage. */
const VERSION='tropnik-shell-0.4.33-d0e87e6979ac016c';
const SHELL=["/maps/map-coverage-lod.js","/data/map-coverage/manifest.json","/data/map-coverage/base.coverage","/maps/russia-viewport.js","/data/russia-display-area.geojson","/data/russia-outside-mask.geojson","/data/russia-canonical-mask.geojson","/data/russia-boundaries-provenance.json","/offline-fonts.css","/fonts/MANROPE-LICENSE.txt","/fonts/manrope-latin-400.woff2","/fonts/manrope-cyrillic-400.woff2","/fonts/manrope-latin-600.woff2","/fonts/manrope-cyrillic-600.woff2","/offline-safety.html","/offline-safety.js","/offline-safety.css","/offline-viewer.html","/offline.js","/offline.css","/favicon.svg","/data/world.geojson","/data/regions.geojson","/data/territories.geojson"];
const MAP_WARM=['/terrain/ATTRIBUTION.txt','/terrain/sources/Copernicus-GLO30-LICENSE.pdf'];
// BEGIN GENERATED CUSTOM MAP
const CUSTOM_MAP_RESOURCES=[{"path":"/custom-map/catalogue.json","sizeBytes":167378,"sha256":"bad517373c27101ea8fe93423083f3636c11cf65824c2202f69cc2c2bf414aa3"},{"path":"/custom-map/chunks/custom-map-entry-Pq9Hi9PD.js","sizeBytes":155510,"sha256":"ea3d2f190b1b69b54e4dba9156be06e7cb68e1fc7b32aa35104aef4dfa271e16"},{"path":"/custom-map/Manrope-OFL.txt","sizeBytes":4383,"sha256":"d826ab6583b12c26807d8716a545bdbbb672df04f48608a364ba9efdbe501c30"},{"path":"/custom-map/map-runtime.js","sizeBytes":224,"sha256":"77fe444598b7395231e727ed0b86d1ed0115cbd11f265b27a4ec7d63c3dfc61b"},{"path":"/custom-map/map.css","sizeBytes":82304,"sha256":"8e56ccd8993e60f3ba822b939543c19be14d3db4562130c6460422bdb6e74e88"},{"path":"/custom-map/workers/custom-map-tiles.worker-BOzbsGer.js","sizeBytes":28787,"sha256":"c0995a8f541b049796dccb48bc20b54135e6d218a24fa7aeefb2ba8a2c8f0636"},{"path":"/custom-map/workers/custom-map-trail-raster.worker-CZZMbu81.js","sizeBytes":2387,"sha256":"bfec0605c231da3c03fca6403800e8b0ff7678ed83e66218dfa973d7e26c7345"},{"path":"/custom-map/workers/terrain-preparation.worker-Bb-s7l3H.js","sizeBytes":2891,"sha256":"625ce56a5be80c34fe32704e0fe93aa1a5c83e56d719c1fcfea511ba56583931"},{"path":"/custom-map/manifest.json","sizeBytes":533835,"sha256":"33af70aaf5ec84df9f0aeb4d37777acb15fa7d2458db40af40d84efbc63cffea"}];
// END GENERATED CUSTOM MAP
const CUSTOM_MAP_URLS=new Set(CUSTOM_MAP_RESOURCES.map(file=>file.path));
const warmJobs=new Map();
const MAP_WARM_TIMEOUT_MS=12000;
let warmBlocked=false;
function warmAbortReason(signal){return signal.reason||new DOMException('Map warmup cancelled','AbortError');}
function checkWarm(signal){if(signal?.aborted)throw warmAbortReason(signal);}
function waitWarm(work,signal){
 if(!signal)return Promise.resolve(work);
 return new Promise((resolve,reject)=>{
  const stop=()=>{signal.removeEventListener('abort',stop);reject(warmAbortReason(signal));};
  signal.addEventListener('abort',stop,{once:true});
  Promise.resolve(work).then(value=>{signal.removeEventListener('abort',stop);if(signal.aborted)reject(warmAbortReason(signal));else resolve(value);},error=>{signal.removeEventListener('abort',stop);reject(error);});
  if(signal.aborted)stop();
 });
}
function fetchWarm(path,options={},signal){
 checkWarm(signal);
 const work=fetch(path,{...options,...(signal?{signal}:{})}).then(response=>{
  if(signal?.aborted){response.body?.cancel().catch(()=>{});throw warmAbortReason(signal);}return response;
 });
 return waitWarm(work,signal);
}
function putWarm(cache,path,response,signal){checkWarm(signal);return waitWarm(cache.put(path,response),signal);}
async function cacheWarmAssets(cache,paths,signal){
 let index=0;
 await Promise.all(Array.from({length:Math.min(3,paths.length)},async()=>{
  while(index<paths.length){checkWarm(signal);const path=paths[index++],response=await fetchWarm(path,{credentials:'omit'},signal);
   if(!response.ok||response.type!=='basic')throw new Error('Map warm asset unavailable');
   await putWarm(cache,path,response,signal);
  }
 }));
}
function cancelMapWarm(retiring=true){if(retiring)warmBlocked=true;for(const job of warmJobs.values())job.controller.abort();}
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
// Only visited public trail data is retained. Query strings remain part of the
// key, so an imported track requested with a new ?v= cannot reuse old bytes.
const TRAIL_DATA_ROOT='/data/';
const TRAIL_CACHE_LIMITS={bytes:32*1024*1024,entries:64,fileBytes:4*1024*1024};
let trailWrites=Promise.resolve();
function trailData(path){
 return path.startsWith(TRAIL_DATA_ROOT)&&/^(?:trail-overlay-[a-f0-9]{16}\.json|imported\/[a-z0-9-]+\.geojson)$/.test(path.slice(TRAIL_DATA_ROOT.length));
}
function rememberTrailData(cache,key,response){
 const job=trailWrites.then(async()=>{
  if(Number(response.headers.get('content-length'))>TRAIL_CACHE_LIMITS.fileBytes){response.body?.cancel().catch(()=>{});return;}
  const reader=response.body?.getReader();if(!reader)return;
  const parts=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>TRAIL_CACHE_LIMITS.fileBytes){reader.cancel().catch(()=>{});return;}parts.push(value);}}finally{reader.releaseLock();}
  if(!size)return;
  const retained=[];let total=0;
  for(const request of await cache.keys()){
   const url=new URL(request.url);if(!trailData(url.pathname))continue;
   if(url.pathname+url.search===key){await cache.delete(request);continue;}
   const cached=await cache.match(request),bytes=Number(cached?.headers.get('x-tropnik-trail-bytes'));
   if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>TRAIL_CACHE_LIMITS.fileBytes){await cache.delete(request);continue;}
   retained.push({request,bytes});total+=bytes;
  }
  while(retained.length&&(retained.length>=TRAIL_CACHE_LIMITS.entries||total+size>TRAIL_CACHE_LIMITS.bytes)){const old=retained.shift();await cache.delete(old.request);total-=old.bytes;}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  await cache.put(key,new Response(bytes,{headers:{'Content-Type':response.headers.get('Content-Type')||'application/json','X-Tropnik-Trail-Bytes':String(size)}}));
 });
 trailWrites=job.catch(()=>{});return trailWrites;
}
async function trailDataResponse(request,url){
 if(request.cache==='no-store')return{response:await fetch(request)};
 const cache=await caches.open(VERSION),key=url.pathname+url.search;
 if(request.cache!=='reload'){const found=await cache.match(key);if(found)return{response:found};}
 const response=await fetch(request);
 const write=response.ok&&response.type==='basic'?rememberTrailData(cache,key,response.clone()):undefined;
 return{response,write};
}
async function cacheOverview(cache,signal){
 const base='/maps/russia-relief/',response=await fetchWarm(base+'manifest.json',{cache:'no-store'},signal);
 if(!response.ok)throw new Error('Overview manifest unavailable');
 const manifestText=await waitWarm(response.text(),signal);let manifest;
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
   checkWarm(signal);const {file,paths}=pending[index++],result=await fetchWarm(base+file.path,{},signal);
   if(!result.ok)throw new Error('Overview tile unavailable');
   const bytes=await waitWarm(result.arrayBuffer(),signal);
   const hash=[...new Uint8Array(await waitWarm(crypto.subtle.digest('SHA-256',bytes),signal))].map(x=>x.toString(16).padStart(2,'0')).join('');
   if(bytes.byteLength!==file.bytes||hash!==file.sha256)throw new Error('Overview tile integrity mismatch');
   for(const path of paths)await putWarm(cache,base+path,new Response(bytes,{headers:{'Content-Type':'image/png'}}),signal);
  }
 }));
 await putWarm(cache,base+'manifest.json',new Response(manifestText,{headers:{'Content-Type':response.headers.get('Content-Type')||'application/json'}}),signal);
 await cacheWarmAssets(cache,[base+'tilejson.json',base+'ATTRIBUTION.txt'],signal);
}
async function cacheCustomMapRuntime(cache,signal){
 if(!CUSTOM_MAP_RESOURCES.length||CUSTOM_MAP_RESOURCES.length>64)throw new Error('Missing shared map shell');
 let index=0,total=0;
 await Promise.all(Array.from({length:3},async()=>{
  while(index<CUSTOM_MAP_RESOURCES.length){
   checkWarm(signal);
   const file=CUSTOM_MAP_RESOURCES[index++];
   if(!file.path.startsWith('/custom-map/')||!Number.isSafeInteger(file.sizeBytes)||file.sizeBytes<=0||file.sizeBytes>2*1024*1024||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Invalid shared map shell');
   total+=file.sizeBytes;if(total>4*1024*1024)throw new Error('Shared map shell exceeds budget');
   const cached=await waitWarm(cache.match(file.path),signal),response=cached||await fetchWarm(file.path,{cache:'no-store',credentials:'omit'},signal);
   if(!response.ok||(!cached&&response.type!=='basic'))throw new Error('Shared map runtime unavailable');
   const bytes=await waitWarm(response.arrayBuffer(),signal);
   const actual=[...new Uint8Array(await waitWarm(crypto.subtle.digest('SHA-256',bytes),signal))].map(value=>value.toString(16).padStart(2,'0')).join('');
   if(bytes.byteLength!==file.sizeBytes||actual!==file.sha256)throw new Error('Shared map runtime integrity mismatch');
   await putWarm(cache,file.path,new Response(bytes,{headers:{'Content-Type':response.headers.get('Content-Type')||'application/octet-stream'}}),signal);
  }
 }));
}
function warmMapCache(){
 if(warmBlocked)return Promise.resolve();
 const kind='canvas',marker=`/_offline/map-warm-${VERSION}-${kind}`;
 if(warmJobs.has(kind))return warmJobs.get(kind).promise;
 const controller=new AbortController(),signal=controller.signal,entry={controller,promise:null};
 const timer=setTimeout(()=>controller.abort(),MAP_WARM_TIMEOUT_MS);
 const work=(async()=>{
  const cache=await waitWarm(caches.open(VERSION),signal);if(await waitWarm(cache.match(marker),signal))return;
  await cacheWarmAssets(cache,MAP_WARM,signal);await cacheCustomMapRuntime(cache,signal);await cacheOverview(cache,signal);
  await putWarm(cache,marker,new Response('ready',{headers:{'Content-Type':'text/plain'}}),signal);
 })();
 entry.promise=waitWarm(work,signal).catch(error=>{controller.abort();if(warmJobs.get(kind)===entry)warmJobs.delete(kind);throw error;}).finally(()=>clearTimeout(timer));
 warmJobs.set(kind,entry);return entry.promise;
}
self.addEventListener('install',event=>{event.waitUntil((async()=>{const cache=await caches.open(VERSION);await Promise.all([cache.addAll(SHELL),cacheCustomMapRuntime(cache)]);})());});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('tropnik-shell-')&&name!==VERSION)await caches.delete(name);await self.clients.claim();})());});
self.addEventListener('message',event=>{if(event.data?.type==='skip-waiting'){cancelMapWarm(false);event.waitUntil(self.skipWaiting());}else if(event.data?.type==='cancel-map-warm')cancelMapWarm();else if(event.data?.type==='warm-map')event.waitUntil(warmMapCache().catch(error=>{if(error?.name!=='AbortError')throw error;}));});
async function verifiedResource(request){const names=(await caches.keys()).filter(n=>n.startsWith('tropnik-map-')).sort().reverse();for(const name of names){const cache=await caches.open(name);if(await cache.match('/_offline/verified-map')){const match=await cache.match(request);if(match)return match;}}return null;}
async function publicAssetResponse(request,url){
 const refresh=request.cache==='no-store'||request.cache==='reload';
 const cache=request.cache==='no-store'?null:await caches.open(VERSION);
 if(!refresh){const found=await cache.match(request);if(found)return found;}
 let response;
 try{response=await fetch(request);}
 catch(error){
  // An HTTP-cache refresh must not disable an installed emergency viewer offline.
  // Source geometry and other assets keep strict retries without stale fallback.
  if(refresh&&SHELL.includes(url.pathname)){
   const shell=cache||await caches.open(VERSION),found=await shell.match(request);
   if(found)return found;
  }
  throw error;
 }
 if(cache&&response.ok&&response.type==='basic')await cache.put(request,response.clone());
 return response;
}
self.addEventListener('fetch',event=>{const req=event.request,url=new URL(req.url);if(req.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||req.headers.get('RSC'))return;
 if(coverageCell(url.pathname)){const result=coverageResponse(req,url);event.respondWith(result.then(value=>value.response));event.waitUntil(result.then(value=>value.write).catch(()=>{}));return;}
 if(trailData(url.pathname)){const result=trailDataResponse(req,url);event.respondWith(result.then(value=>value.response));event.waitUntil(result.then(value=>value.write).catch(()=>{}));return;}
 if(url.pathname.startsWith('/offline-map/')){event.respondWith((async()=>{if(req.cache==='no-store'||req.cache==='reload')return fetch(req);const found=await verifiedResource(req);if(found)return found;return fetch(req);})());return;}
 if(req.mode==='navigate'){event.respondWith(fetch(req).catch(async()=>{const cache=await caches.open(VERSION);if(SAFETY_PAGES.includes(url.pathname))return await cache.match('/offline-safety.html')||Response.error();return await cache.match(url.pathname)||await cache.match('/offline-viewer.html')||Response.error();}));return;}
 const permitted=['/terrain/terrain-grid.json','/terrain/terrain-preview.json'].includes(url.pathname)||SHELL.includes(url.pathname)||MAP_WARM.includes(url.pathname)||CUSTOM_MAP_URLS.has(url.pathname)||url.pathname.startsWith('/_next/static/')||url.pathname.startsWith('/assets/')||url.pathname.startsWith('/data/routes/')||url.pathname.startsWith('/maps/russia-relief/');if(!permitted)return;
 event.respondWith(publicAssetResponse(req,url));
});
