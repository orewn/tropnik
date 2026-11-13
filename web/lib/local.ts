import type { Trail } from './content';
import {readRouteGeometry} from './route-geometry.ts';
import {loadVerifiedRouteGeometry,ROUTE_SOURCE_DATA_ROOT} from './route-source-integrity.ts';
import {MAP_RESOURCE_LIMITS} from './map-config.ts';
import trailOverlayMetadata from './trail-overlay.generated.json' with {type:'json'};

const DB_NAME = 'tropa-local-v1';
const API_ROUTE_ROOT='/api/backend/routes/';
export type SavedPack = {id:string; title:string; regionId:string; savedAt:string; sourceCheckedAt:string; kind:'reference'; trail:Trail; geometry:unknown|null; bytes:number};
function database():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>{const db=req.result; if(!db.objectStoreNames.contains('packs'))db.createObjectStore('packs',{keyPath:'id'});};
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error || new Error('Хранилище недоступно'));
  });
}
export async function packs():Promise<SavedPack[]> {
  const db=await database();
  try{return await transaction<SavedPack[]>(db,'readonly',store=>store.getAll());}
  finally{db.close();}
}
function transaction<T>(db:IDBDatabase,mode:IDBTransactionMode,request:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T>{
  return new Promise((resolve,reject)=>{
    let tx:IDBTransaction|undefined;
    try{
      tx=db.transaction('packs',mode);
      const active=tx;
      let failure:DOMException|null=null;
      active.onerror=()=>reject(failure||active.error||new Error('Не удалось обновить хранилище.'));
      active.onabort=()=>reject(failure||active.error||new Error('Операция с хранилищем отменена.'));
      const result=request(active.objectStore('packs'));
      result.onerror=()=>{failure=result.error;};
      active.oncomplete=()=>resolve(result.result);
    }catch(error){try{tx?.abort();}catch{}reject(error);}
  });
}
async function readSavedSource(url:string,signal:AbortSignal,cache:RequestCache):Promise<ArrayBuffer>{
  const response=await fetch(url,{signal,cache,credentials:'same-origin'});
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new Error('Route source unavailable');}
  const reader=response.body?.getReader();
  if(!reader)throw new Error('Route source has no bytes');
  const chunks:Uint8Array[]=[];let size=0;
  try{
    if(Number(response.headers.get('content-length'))>MAP_RESOURCE_LIMITS.maxResourceBytes)throw new Error('Route source exceeds the byte budget');
    for(;;){
      signal.throwIfAborted();
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>MAP_RESOURCE_LIMITS.maxResourceBytes)throw new Error('Route source exceeds the byte budget');
      chunks.push(value);
    }
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return bytes.buffer;
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function savedGeometry(trail:Trail){
  const source=trail.geometryUrl;
  // Static references use the same versioned byte identity as the opened map.
  // Inline API geometry retains its reviewed revision and is never replaced by
  // a second, possibly newer response while the card is being saved.
  if(!source?.startsWith(ROUTE_SOURCE_DATA_ROOT)&&trail.geometry!=null)return readRouteGeometry(trail.geometry);
  if(!source)return null;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),MAP_RESOURCE_LIMITS.timeoutMs);
  try{
    if(source.startsWith(ROUTE_SOURCE_DATA_ROOT)){
      let reload=false;
      const options={signal:controller.signal,
        load:(url:string,_priority:number,signal:AbortSignal)=>readSavedSource(url,signal,reload?'reload':'default'),
        invalidate:()=>{reload=true;}};
      try{return await loadVerifiedRouteGeometry(source,trailOverlayMetadata.sourceHashes,options);}
      catch(error){
        // An invalid cached response gets one fresh, bounded read. Network
        // failures do not retry, and no IndexedDB mutation precedes validation.
        if(!reload||controller.signal.aborted)throw error;
        return await loadVerifiedRouteGeometry(source,trailOverlayMetadata.sourceHashes,options);
      }
    }
    // Published routes normally carry inline geometry. Keep the existing API
    // envelope fallback private and uncached, rather than treating it as a
    // catalogue resource with an invented source hash.
    if(trail.publicationStatus!=='published'||!source.startsWith(API_ROUTE_ROOT)||!(/^[\w-]+$/).test(source.slice(API_ROUTE_ROOT.length)))throw new Error('Unknown route source');
    const bytes=await readSavedSource(source,controller.signal,'no-store');
    controller.signal.throwIfAborted();
    return readRouteGeometry(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  }finally{clearTimeout(timer);controller.abort();}
}
export async function saveReference(trail:Trail):Promise<SavedPack> {
  let geometry:unknown|null;
  try{geometry=await savedGeometry(trail);}
  catch(error){throw new Error('Не удалось проверить и сохранить геометрию. Пакет не изменён.',{cause:error});}
  const value:SavedPack={id:trail.id,title:trail.title,regionId:trail.regionId,savedAt:new Date().toISOString(),sourceCheckedAt:trail.checkedAt,kind:'reference',trail,geometry,bytes:0};
  value.bytes=new Blob([JSON.stringify(value)]).size;
  const db=await database();
  try{await transaction(db,'readwrite',store=>store.put(value));return value;}
  finally{db.close();}
}
export async function deletePack(id:string){const db=await database();try{await transaction(db,'readwrite',store=>store.delete(id));}finally{db.close();}}
export function downloadJson(name:string,data:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
