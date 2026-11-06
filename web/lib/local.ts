import type { Trail } from './content';

const DB_NAME = 'tropa-local-v1';
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
  return new Promise((resolve,reject)=>{const tx=db.transaction('packs');const req=tx.objectStore('packs').getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);tx.oncomplete=()=>db.close();});
}
export async function saveReference(trail:Trail):Promise<SavedPack> {
  let geometry:unknown|null=null;
  if(trail.geometryUrl){const res=await fetch(trail.geometryUrl);if(!res.ok)throw new Error('Не удалось сохранить геометрию. Пакет не изменён.');const data=await res.json() as any;geometry=data?.data?.geometry||data;}
  const value:SavedPack={id:trail.id,title:trail.title,regionId:trail.regionId,savedAt:new Date().toISOString(),sourceCheckedAt:trail.checkedAt,kind:'reference',trail,geometry,bytes:0};
  value.bytes=new Blob([JSON.stringify(value)]).size;
  const db=await database();
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('packs','readwrite');tx.objectStore('packs').put(value);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
  db.close(); return value;
}
export async function deletePack(id:string){const db=await database();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('packs','readwrite');tx.objectStore('packs').delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();}
export function downloadJson(name:string,data:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
