export type OfflineManifest={id:string;title:string;complete:boolean;bbox:number[];tileCount:number;maxzoom:number;packageBytesIncludingManifest:number;source:{sourceSnapshotDateInIdentifier:string};files:{path:string;bytes:number;sha256:string}[]};
export type MapReceipt={id:string;cacheName:string;savedAt:string;bytes:number;files:number;verified:true;landscape?:boolean};
const receiptPath='/_offline/verified-map';
export async function getMapReceipt():Promise<MapReceipt|null>{if(!('caches'in window))return null;const names=(await caches.keys()).filter(x=>x.startsWith('tropnik-map-')).sort().reverse();for(const name of names){const cache=await caches.open(name);const item=await cache.match(receiptPath);if(item){const receipt=await item.json() as MapReceipt;if(receipt.verified)return receipt;}}return null;}
export async function removeMap(){if(!('caches'in window))return;const names=(await caches.keys()).filter(x=>x.startsWith('tropnik-map-')||x.startsWith('tropnik-staging-'));await Promise.all(names.map(x=>caches.delete(x)));}
export async function downloadMap(onProgress:(loaded:number,total:number)=>void,signal?:AbortSignal):Promise<MapReceipt>{
 if(!window.isSecureContext||!('caches'in window)||!crypto.subtle)throw new Error('Для сохранения подробной карты нужен защищённый HTTPS-адрес и поддержка хранилища браузером.');
 const install=async()=>{
  const response=await fetch('/offline-map/manifest.json',{cache:'no-store',signal});if(!response.ok)throw new Error('Паспорт карты недоступен. Скачивание не начато.');const manifest=await response.json() as OfflineManifest;
  if(!manifest.complete||!manifest.files.length||manifest.files.length>1000||manifest.files.some(f=>!f.path||f.path.startsWith('/')||f.path.split('/').includes('..')||!/^\w[\w /.-]+$/.test(f.path)||!/^[a-f0-9]{64}$/.test(f.sha256)))throw new Error('Паспорт карты не прошёл проверку.');
  const required=manifest.files.reduce((s,f)=>s+f.bytes,0);const quota=await navigator.storage?.estimate();if(typeof quota?.quota==='number'&&typeof quota.usage==='number'&&quota.quota-quota.usage<required*1.5)throw new Error('Недостаточно свободного места для карты. Освободите место и повторите.');
  const cacheName=`tropnik-map-${Date.now()}-${manifest.id}`;const cache=await caches.open(cacheName);let index=0,loaded=0;
  try{
   await Promise.all(Array.from({length:4},async()=>{while(index<manifest.files.length){const file=manifest.files[index++];if(signal?.aborted)throw new DOMException('Aborted','AbortError');const url='/offline-map/'+file.path.split('/').map(encodeURIComponent).join('/');const res=await fetch(url,{cache:'no-store',signal});if(!res.ok)throw new Error('Не все части карты удалось скачать. Пакет не помечен готовым.');const bytes=await res.arrayBuffer();if(bytes.byteLength!==file.bytes)throw new Error('Размер файла карты отличается от паспорта.');const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');if(digest!==file.sha256)throw new Error('Проверка целостности карты не пройдена.');await cache.put(url,new Response(bytes,{headers:{'Content-Type':res.headers.get('Content-Type')||'application/octet-stream'}}));onProgress(++loaded,manifest.files.length);}}));
   for(const path of ['/maps/pilot-style.json','/offline-map/manifest.json']){const res=await fetch(path,{cache:'no-store',signal});if(!res.ok)throw new Error('Не удалось сохранить оформление карты.');await cache.put(path,res);}
   const receipt:MapReceipt={id:manifest.id,cacheName,savedAt:new Date().toISOString(),bytes:required,files:loaded,verified:true,landscape:manifest.files.some(file=>file.path==='terrain/landscape.html')};
   await cache.put(receiptPath,new Response(JSON.stringify(receipt),{headers:{'Content-Type':'application/json'}}));
   const old=(await caches.keys()).filter(x=>x.startsWith('tropnik-map-')&&x!==cacheName);await Promise.all(old.map(x=>caches.delete(x)));
   navigator.storage?.persist?.().catch(()=>{});return receipt;
  }catch(e){await caches.delete(cacheName);throw e;}
 };
 if(navigator.locks)return navigator.locks.request('tropnik-download-map',{mode:'exclusive'},install);return install();
}
