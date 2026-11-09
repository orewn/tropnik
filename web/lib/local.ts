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
function geometryPayload(value:unknown):unknown{
  if(value&&typeof value==='object'&&'data' in value){
    const data=value.data;
    if(data&&typeof data==='object'&&'geometry' in data&&data.geometry)return data.geometry;
  }
  return value;
}
export async function saveReference(trail:Trail):Promise<SavedPack> {
  let geometry:unknown|null=trail.geometry==null?null:geometryPayload(trail.geometry);
  if(geometry===null&&trail.geometryUrl){const res=await fetch(trail.geometryUrl);if(!res.ok)throw new Error('Не удалось сохранить геометрию. Пакет не изменён.');const data:unknown=await res.json();geometry=geometryPayload(data);}
  const value:SavedPack={id:trail.id,title:trail.title,regionId:trail.regionId,savedAt:new Date().toISOString(),sourceCheckedAt:trail.checkedAt,kind:'reference',trail,geometry,bytes:0};
  value.bytes=new Blob([JSON.stringify(value)]).size;
  const db=await database();
  try{await transaction(db,'readwrite',store=>store.put(value));return value;}
  finally{db.close();}
}
export async function deletePack(id:string){const db=await database();try{await transaction(db,'readwrite',store=>store.delete(id));}finally{db.close();}}
export function downloadJson(name:string,data:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
