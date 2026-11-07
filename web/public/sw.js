/* Тропник. Only public static assets are cached. Auth, chat and API responses never enter CacheStorage. */
const VERSION='tropnik-shell-v12';
const SHELL=['/maps/russia-viewport.js','/data/russia-display-area.geojson','/data/russia-outside-mask.geojson','/data/russia-canonical-mask.geojson','/data/russia-boundaries-provenance.json','/terrain/ATTRIBUTION.txt','/terrain/sources/Copernicus-GLO30-LICENSE.pdf','/offline-fonts.css','/fonts/MANROPE-LICENSE.txt','/fonts/manrope-latin-400.woff2','/fonts/manrope-cyrillic-400.woff2','/fonts/manrope-latin-600.woff2','/fonts/manrope-cyrillic-600.woff2','/maps/tropnik-pictograms.js','/maps/tropnik-sprite.png','/maps/tropnik-sprite.json','/maps/tropnik-sprite@2x.png','/maps/tropnik-sprite@2x.json','/maps/tropnik-sprite-provenance.json','/terrain/landscape.html','/maps/leaflet.js','/maps/leaflet.css','/maps/protomaps-leaflet.js','/maps/canvas-style.js','/offline-viewer.html','/offline.js','/offline.css','/favicon.svg','/maps/maplibre-gl.mjs','/maps/maplibre-gl.css','/maps/maplibre-worker.js','/data/world.geojson','/data/regions.geojson','/data/territories.geojson'];
async function cacheOverview(cache){
 const base='/maps/russia-relief/',response=await fetch(base+'manifest.json',{cache:'no-store'});
 if(!response.ok)throw new Error('Overview manifest unavailable');
 const manifest=await response.clone().json();
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
 await cache.put(base+'manifest.json',response);
 await cache.addAll([base+'tilejson.json',base+'ATTRIBUTION.txt']);
}
self.addEventListener('install',event=>{event.waitUntil((async()=>{const cache=await caches.open(VERSION);await cache.addAll(SHELL);await cacheOverview(cache);})());});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('tropnik-shell-')&&name!==VERSION)await caches.delete(name);await self.clients.claim();})());});
async function verifiedResource(request){const names=(await caches.keys()).filter(n=>n.startsWith('tropnik-map-')).sort().reverse();for(const name of names){const cache=await caches.open(name);if(await cache.match('/_offline/verified-map')){const match=await cache.match(request);if(match)return match;}}return null;}
self.addEventListener('fetch',event=>{const req=event.request,url=new URL(req.url);if(req.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||req.headers.get('RSC'))return;
 if(url.pathname.startsWith('/offline-map/')||url.pathname==='/maps/pilot-style.json'){event.respondWith((async()=>{if(req.cache==='no-store'||req.cache==='reload')return fetch(req);const found=await verifiedResource(req);if(found)return found;return fetch(req);})());return;}
 if(req.mode==='navigate'){event.respondWith(fetch(req).catch(async()=>{const cache=await caches.open(VERSION);return await cache.match(url.pathname)||await cache.match('/offline-viewer.html')||Response.error();}));return;}
 const permitted=['/terrain/terrain-grid.json','/terrain/terrain-preview.json'].includes(url.pathname)||SHELL.includes(url.pathname)||url.pathname.startsWith('/_next/static/')||url.pathname.startsWith('/assets/')||url.pathname.startsWith('/data/routes/')||url.pathname.startsWith('/maps/russia-relief/');if(!permitted)return;
 event.respondWith((async()=>{const cache=await caches.open(VERSION);const found=await cache.match(req);if(found)return found;const res=await fetch(req);if(res.ok&&res.type==='basic')await cache.put(req,res.clone());return res;})());
});
