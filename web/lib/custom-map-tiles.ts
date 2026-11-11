import {loadPublicBytes,loadPublicJSON} from './map-preload';
import {SATELLITE_PROVIDERS,type SatelliteSourceId} from './map-satellite';
import type {MapTileLabel,ReliefCoverage,ReliefHaloOffset,ReliefHaloPayload,ReliefHaloSource} from './custom-map-painter';
import tileWorkerURL from './custom-map-tiles.worker.ts?worker&url';

export type CustomTileKind='vector'|'relief'|'overview'|SatelliteSourceId;
export type CustomMapTile={key:string;kind:CustomTileKind;z:number;x:number;y:number;paintZoom?:number;bitmap:ImageBitmap;labels:MapTileLabel[];contours:number;local:boolean;paths?:boolean;transparent?:boolean;reliefCoverage?:ReliefCoverage};
export type CustomTileRequest={kind:CustomTileKind;z:number;x:number;y:number;paintZoom?:number;paths?:boolean;transparent?:boolean};
type Work={id:number;request:CustomTileRequest;key:string;resolve:(tile:CustomMapTile)=>void;reject:(error:Error)=>void;bytes?:ArrayBuffer;halo?:ReliefHaloPayload;local?:boolean;mime?:string;sourceZ?:number;sourceKey?:string;stage:'queued'|'fetching'|'ready'|'decoding'};
const MAX_RESIDENT=96,MAX_BITMAPS=288,MAX_PENDING=160,MAX_FETCHING=3,MAX_READY=6,MAX_TILE_BYTES=8*1024*1024;
const canonicalX=(x:number,z:number)=>((x%2**z)+2**z)%2**z;
function paintZoomFor(tile:CustomTileRequest):number{
  const zoom=tile.paintZoom===undefined?tile.z:tile.paintZoom;
  if(!Number.isInteger(tile.z)||tile.z<0||!Number.isInteger(zoom)||zoom<tile.z||zoom>18)throw new Error('Invalid map paint zoom');
  return zoom;
}
export function customTileKey(tile:CustomTileRequest):string{return `${tile.kind}:${tile.z}/${tile.x}/${tile.y}:${tile.paths!==false?1:0}:${tile.transparent?1:0}:${paintZoomFor(tile)}`;}
/** Only children touching a real parent boundary need adjacent measurements.
 * The maximum overzoom factor is 64, so even a PNG256 child is four samples
 * wide: the next interior child never enters a border pixel's filter support. */
export function reliefHaloOffsets(z:number,x:number,y:number,sourceZ=Math.min(z,12)):ReliefHaloOffset[]{
  const factor=2**(z-sourceZ),childX=x-Math.floor(x/factor)*factor,childY=y-Math.floor(y/factor)*factor;
  const horizontal:Array<-1|0|1>=[0],vertical:Array<-1|0|1>=[0];
  if(childX===0)horizontal.push(-1);if(childX===factor-1)horizontal.push(1);
  if(childY===0)vertical.push(-1);if(childY===factor-1)vertical.push(1);
  const offsets:ReliefHaloOffset[]=[];
  for(const dy of vertical)for(const dx of horizontal)if(dx||dy)offsets.push({dx,dy});
  return offsets;
}

/** One tile decoder and bounded source requests shared by each map instance. */
export class CustomMapTiles {
  private cache=new Map<string,CustomMapTile>();
  private jobs=new Map<string,{work:Work;promise:Promise<CustomMapTile>}>();
  private pinned=new Set<string>();
  private worker?:Worker;
  private active?:Work;
  private timer?:ReturnType<typeof setTimeout>;
  private fetching=0;
  private serial=0;
  private disposed=false;
  private enabled=true;
  private template?:Promise<string>;
  private localFiles?:Promise<Set<string>>;
  private errors:Array<{key:string;message:string}>=[];
  snapshot(){return{resident:this.cache.size,pending:this.jobs.size,fetching:this.fetching,decoding:!!this.active,enabled:this.enabled,stages:[...this.jobs.values()].reduce<Record<string,number>>((counts,{work})=>{counts[work.stage]=(counts[work.stage]||0)+1;return counts;},{}),errors:this.errors.map(error=>({...error}))};}
  get pending(){return this.jobs.size;}
  get resident(){return this.cache.size;}
  setActive(active:boolean){this.enabled=active;if(active)this.pump();}
  pin(keys:Iterable<string>){
    this.pinned=new Set(keys);
    for(const [key,{work}] of this.jobs)if(!this.pinned.has(key)&&work.stage!=='decoding'){this.jobs.delete(key);work.bytes=undefined;work.halo=undefined;work.reject(new Error('Map view changed'));}
    this.evict(true);
  }
  peek(key:string){return this.cache.get(key);}
  load(request:CustomTileRequest):Promise<CustomMapTile>{
    if(this.disposed)return Promise.reject(new Error('Map resources released'));
    let key:string;try{key=customTileKey(request);}catch(error){return Promise.reject(error instanceof Error?error:new Error('Invalid map tile request'));}
    const cached=this.cache.get(key),previous=this.jobs.get(key);
    if(cached){this.cache.delete(key);this.cache.set(key,cached);return Promise.resolve(cached);}
    if(previous)return previous.promise;
    if(this.jobs.size>=MAX_PENDING)return Promise.reject(new Error('Map tile queue is full'));
    let resolve!:(tile:CustomMapTile)=>void,reject!:(error:Error)=>void;
    const promise=new Promise<CustomMapTile>((yes,no)=>{resolve=yes;reject=no;});
    const work:Work={id:++this.serial,request,key,resolve,reject,stage:'queued'};
    this.jobs.set(key,{work,promise});this.pump();return promise;
  }
  private files(){
    return this.localFiles??=loadPublicJSON<{files:Array<{path:string}>}>('/offline-map/manifest.json').then(m=>new Set(m.files.map(f=>f.path))).catch(()=>new Set<string>());
  }
  private async source(work:Work){
    const {kind}=work.request,z=Math.min(work.request.z,kind==='vector'?14:kind==='relief'?12:work.request.z),factor=2**(work.request.z-z),x=Math.floor(work.request.x/factor),y=Math.floor(work.request.y/factor),tx=canonicalX(x,z);
    work.sourceZ=z;
    if(kind==='overview')return{url:`/maps/russia-relief/${z}/${tx}/${y}.png`,local:true,mime:'image/png'};
    if(kind==='eox-s2'||kind==='eox-bluemarble')return{url:SATELLITE_PROVIDERS[kind].tiles.replace('{z}',String(z)).replace('{x}',String(tx)).replace('{y}',String(y)),local:false,mime:'image/jpeg'};
    const path=kind==='vector'?`localtiles/${z}/${tx}/${y}.pbf`:`terrain/tiles/${z}/${tx}/${y}.png`;
    if((await this.files()).has(path))return{url:`/offline-map/${path}`,local:true,mime:kind==='vector'?'application/x-protobuf':'image/png'};
    if(!navigator.onLine)throw new Error('This tile is not in the saved package');
    if(kind==='relief')return{url:`https://tiles.mapterhorn.com/${z}/${tx}/${y}.webp`,local:false,mime:'image/webp'};
    const template=await (this.template??=loadPublicJSON<{tiles:string[]}>('https://tiles.openfreemap.org/planet/latest').then(data=>{
      const url=data.tiles?.[0];if(!url?.startsWith('https://tiles.openfreemap.org/'))throw new Error('Unrecognized vector source');return url;
    }).catch(error=>{this.template=undefined;throw error;}));
    return{url:template.replace('{z}',String(z)).replace('{x}',String(tx)).replace('{y}',String(y)),local:false,mime:'application/x-protobuf'};
  }
  private current(work:Work){return !this.disposed&&this.jobs.get(work.key)?.work===work;}
  private async fetch(work:Work){
    const source=await this.source(work);if(!this.current(work))return;
    work.local=source.local;work.mime=source.mime;work.sourceKey=source.url;
    const bytes=await loadPublicBytes(source.url,0);if(!this.current(work))return;
    if(!bytes.byteLength||bytes.byteLength>MAX_TILE_BYTES)throw new Error('Map source exceeds tile budget');
    // The shared byte pool keeps its copy when the whole bounded payload is
    // transferred. A halo uses the same three fetching slots, never a new pool.
    work.bytes=bytes.slice(0);
    if(work.request.kind==='relief'){
      const {z,x,y}=work.request,sourceZ=work.sourceZ!,factor=2**(z-sourceZ),parentX=Math.floor(x/factor),parentY=Math.floor(y/factor);
      const halo:ReliefHaloPayload={tiles:[],missing:[]};work.halo=halo;
      const copies=new Map<string,ArrayBuffer>([[source.url,work.bytes]]);let total=bytes.byteLength;
      const files=work.local?await this.files():undefined;
      for(const offset of reliefHaloOffsets(z,x,y,sourceZ)){
        if(!this.current(work))return;
        const tx=canonicalX(parentX+offset.dx,sourceZ),ty=parentY+offset.dy;
        if(ty<0||ty>=2**sourceZ){halo.missing.push({...offset,reason:'coverage'});continue;}
        const path=`terrain/tiles/${sourceZ}/${tx}/${ty}.png`,local=!!work.local&&!!files?.has(path);
        if(!local&&!navigator.onLine){halo.missing.push({...offset,reason:'unavailable'});continue;}
        const sourceKey=local?`/offline-map/${path}`:`https://tiles.mapterhorn.com/${sourceZ}/${tx}/${ty}.webp`;
        const item:Omit<ReliefHaloSource,'bytes'>={...offset,sourceKey,mime:local?'image/png':'image/webp',...(!local&&work.local?{reduceToArchive:true}:{})};
        try{
          let copy=copies.get(sourceKey);
          if(!copy){
            if(total>=MAX_TILE_BYTES){halo.missing.push({...offset,reason:'budget'});continue;}
            // Sequential within each Work, hence at most three simultaneous
            // primary/halo reads even when all six ready slots are occupied.
            const neighbour=await loadPublicBytes(sourceKey,0);if(!this.current(work))return;
            if(!neighbour.byteLength){halo.missing.push({...offset,reason:'invalid'});continue;}
            if(total+neighbour.byteLength>MAX_TILE_BYTES){halo.missing.push({...offset,reason:'budget'});continue;}
            copy=neighbour.slice(0);copies.set(sourceKey,copy);total+=copy.byteLength;
          }
          halo.tiles.push({...item,bytes:copy});
        }catch{if(!this.current(work))return;halo.missing.push({...offset,reason:'unavailable'});}
      }
    }
    if(this.current(work))work.stage='ready';
  }
  private finish(work:Work,tile?:CustomMapTile,error?:Error){
    work.bytes=undefined;work.halo=undefined;
    if(this.jobs.get(work.key)?.work!==work){tile?.bitmap.close();return;}
    this.jobs.delete(work.key);
    if(tile&&!this.disposed&&this.cache.size<MAX_BITMAPS){this.cache.set(work.key,tile);work.resolve(tile);this.evict();}
    else{tile?.bitmap.close();const failure=error||new Error('Map tile unavailable');this.errors.push({key:work.key,message:failure.message});if(this.errors.length>6)this.errors.shift();work.reject(failure);}
    this.pump();
  }
  private evict(discardPartial=false){
    for(const [key,tile] of this.cache){
      if(this.pinned.has(key))continue;
      // Transient missing neighbours may recover on a later visit. Keep the
      // currently displayed bitmap alive, then discard it once it is unpinned.
      if(this.cache.size<=MAX_RESIDENT&&!(discardPartial&&tile.reliefCoverage?.missing.some(item=>item.reason!=='coverage')))continue;
      this.cache.delete(key);tile.bitmap.close();
    }
  }
  private decode(work:Work){
    try{
      if(!this.worker){
        const worker=new Worker(new URL(tileWorkerURL,location.href),{type:'module',name:'tropnik-cartography'});this.worker=worker;
        worker.onmessage=(event:MessageEvent<{id:number;bitmap?:ImageBitmap;labels?:MapTileLabel[];contours?:number;reliefCoverage?:ReliefCoverage;error?:string}>)=>{
          const item=this.active;if(!item||event.data.id!==item.id||this.disposed){event.data.bitmap?.close();return;}
          clearTimeout(this.timer);this.active=undefined;
          if(event.data.bitmap)this.finish(item,{key:item.key,...item.request,bitmap:event.data.bitmap,labels:event.data.labels||[],contours:event.data.contours||0,local:!!item.local,...(event.data.reliefCoverage?{reliefCoverage:event.data.reliefCoverage}:{})});
          else this.finish(item,undefined,new Error(event.data.error||'Tile decoding failed'));
        };
        worker.onerror=event=>this.failWorker(event.message||'Map tile worker failed');
      }
      this.active=work;work.stage='decoding';const bytes=work.bytes!,halo=work.halo;work.bytes=undefined;work.halo=undefined;
      this.timer=setTimeout(()=>this.failWorker(),15000);
      this.worker.postMessage({id:work.id,kind:work.request.kind==='vector'?'vector':work.request.kind==='relief'?'relief':'raster',bytes,z:work.request.z,x:work.request.x,y:work.request.y,paintZoom:paintZoomFor(work.request),sourceZ:work.sourceZ,sourceKey:work.sourceKey,paths:work.request.paths!==false,transparent:work.request.transparent,mime:work.mime,halo},[...new Set([bytes,...(halo?.tiles.map(item=>item.bytes)??[])])]);
    }catch(error){this.active=undefined;clearTimeout(this.timer);this.finish(work,undefined,error instanceof Error?error:new Error('Map worker unavailable'));}
  }
  private failWorker(message='Map tile worker failed'){
    const work=this.active;this.active=undefined;clearTimeout(this.timer);this.worker?.terminate();this.worker=undefined;
    if(work)this.finish(work,undefined,new Error(message));
  }
  private pump(){
    if(this.disposed||!this.enabled)return;
    if(!this.active){const ready=[...this.jobs.values()].find(j=>j.work.stage==='ready');if(ready)this.decode(ready.work);}
    while(this.fetching<MAX_FETCHING&&[...this.jobs.values()].filter(job=>job.work.stage==='ready').length+this.fetching<MAX_READY){
      const queued=[...this.jobs.values()].find(j=>j.work.stage==='queued');if(!queued)break;
      const work=queued.work;work.stage='fetching';this.fetching++;
      void this.fetch(work).catch(error=>this.finish(work,undefined,error instanceof Error?error:new Error('Tile download failed')))
        .finally(()=>{this.fetching--;this.pump();});
    }
  }
  destroy(){
    if(this.disposed)return;this.disposed=true;clearTimeout(this.timer);this.worker?.terminate();this.worker=undefined;
    for(const {work} of this.jobs.values()){work.bytes=undefined;work.halo=undefined;work.reject(new Error('Map resources released'));}
    this.jobs.clear();for(const tile of this.cache.values())tile.bitmap.close();this.cache.clear();this.pinned.clear();this.active=undefined;
  }
}
