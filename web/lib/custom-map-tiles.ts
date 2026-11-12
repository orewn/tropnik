import {loadPublicBytes,loadPublicJSON} from './map-preload';
import {SATELLITE_PROVIDERS,type SatelliteSourceId} from './map-satellite';
import type {MapTileLabel,ReliefCoverage,ReliefHaloOffset,ReliefHaloPayload,ReliefHaloSource} from './custom-map-painter';
import tileWorkerURL from './custom-map-tiles.worker.ts?worker&url';

export type CustomTileKind='vector'|'relief'|'overview'|SatelliteSourceId;
export type CustomMapTile={key:string;kind:CustomTileKind;z:number;x:number;y:number;paintZoom?:number;bitmap:ImageBitmap;labels:MapTileLabel[];contours:number;local:boolean;paths?:boolean;transparent?:boolean;boundaries?:boolean;reliefCoverage?:ReliefCoverage};
export type CustomTileRequest={kind:CustomTileKind;z:number;x:number;y:number;paintZoom?:number;paths?:boolean;transparent?:boolean;boundaries?:boolean};
type TileSource={url:string;local:boolean;mime:string};
type HaloPlan={offsets:ReliefHaloOffset[];index:number;sourceZ:number;parentX:number;parentY:number;files?:Set<string>;copies:Map<string,ArrayBuffer>;bytes:number};
type HaloDependency={item:Omit<ReliefHaloSource,'bytes'>}|{reason:'coverage'|'unavailable'};
type Work={id:number;request:CustomTileRequest;key:string;resolve:(tile:CustomMapTile)=>void;reject:(error:Error)=>void;controller:AbortController;source?:TileSource;bytes?:ArrayBuffer;halo?:ReliefHaloPayload;haloPlan?:HaloPlan;local?:boolean;mime?:string;sourceZ?:number;sourceKey?:string;stage:'queued'|'fetching'|'halo'|'ready'|'decoding'};
const MAX_RESIDENT=96,MAX_BITMAPS=288,MAX_PENDING=160,MAX_FETCHING=3,MAX_READY=6,MAX_TILE_BYTES=8*1024*1024;
const canonicalX=(x:number,z:number)=>((x%2**z)+2**z)%2**z;
function paintZoomFor(tile:CustomTileRequest):number{
  const zoom=tile.paintZoom===undefined?tile.z:tile.paintZoom;
  if(!Number.isInteger(tile.z)||tile.z<0||!Number.isInteger(zoom)||zoom<tile.z||zoom>18)throw new Error('Invalid map paint zoom');
  return zoom;
}
export function customTileKey(tile:CustomTileRequest):string{return `${tile.kind}:${tile.z}/${tile.x}/${tile.y}:${tile.paths!==false?1:0}:${tile.transparent?1:0}:${paintZoomFor(tile)}:${tile.boundaries!==false?1:0}`;}
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
  private reading=new Set<string>();
  private lastFetchKind?:CustomTileKind;
  private lastHaloWork=0;
  private lastDecodeKind?:CustomTileKind;
  private serial=0;
  private disposed=false;
  private enabled=true;
  private template?:Promise<string>;
  private localFiles?:Promise<Set<string>>;
  private errors:Array<{key:string;message:string}>=[];
  constructor(private readonly softwareRaster=false){}
  snapshot(){return{resident:this.cache.size,pending:this.jobs.size,fetching:this.fetching,decoding:!!this.active,enabled:this.enabled,stages:[...this.jobs.values()].reduce<Record<string,number>>((counts,{work})=>{counts[work.stage]=(counts[work.stage]||0)+1;return counts;},{}),errors:this.errors.map(error=>({...error}))};}
  get pending(){return this.jobs.size;}
  get resident(){return this.cache.size;}
  setActive(active:boolean){this.enabled=active;if(active)this.pump();}
  pin(keys:Iterable<string>){
    this.pinned=new Set(keys);
    for(const [key,{work}] of this.jobs)if(!this.pinned.has(key)&&work.stage!=='decoding'){this.jobs.delete(key);work.controller.abort();work.bytes=undefined;work.halo=undefined;work.haloPlan=undefined;work.reject(new Error('Map view changed'));}
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
    const work:Work={id:++this.serial,request,key,resolve,reject,controller:new AbortController(),stage:'queued'};
    this.jobs.set(key,{work,promise});this.pump();return promise;
  }
  private files(){
    return this.localFiles??=loadPublicJSON<{files:Array<{path:string}>}>('/offline-map/manifest.json').then(m=>new Set(m.files.map(f=>f.path))).catch(()=>{
      // Share one in-flight index read, but do not turn a transient failure into
      // a permanent empty package for the lifetime of this map.
      this.localFiles=undefined;return new Set<string>();
    });
  }
  private async source(work:Work):Promise<TileSource>{
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
  private async readSource(work:Work,url:string,priority:number){
    // The shared pool owns cache bytes, consumer leases and the global HTTP
    // cap. A source may occupy only one of this map's read slots: sibling
    // tiles park until its pooled result can be consumed without waiting.
    this.reading.add(url);
    try{return await loadPublicBytes(url,priority,work.controller.signal);}
    finally{this.reading.delete(url);}
  }
  private async fetchPrimary(work:Work){
    const source=work.source??await this.source(work);if(!this.current(work))return;
    work.source=source;
    if(this.reading.has(source.url)){work.stage='queued';return;}
    work.local=source.local;work.mime=source.mime;work.sourceKey=source.url;
    const bytes=await this.readSource(work,source.url,0);if(!this.current(work))return;
    if(bytes.byteLength>MAX_TILE_BYTES)throw new Error('Map source exceeds tile budget');
    // MVT's repeated layers may be empty: OpenFreeMap deliberately responds
    // HTTP 200 with zero bytes for an empty tile. Images still need real data.
    if(!bytes.byteLength&&work.request.kind!=='vector')throw new Error('Empty raster map source');
    work.bytes=bytes.slice(0);
    if(work.request.kind==='relief'){
      const {z,x,y}=work.request,sourceZ=work.sourceZ!,factor=2**(z-sourceZ),parentX=Math.floor(x/factor),parentY=Math.floor(y/factor);
      const files=work.local?await this.files():undefined;
      if(!this.current(work))return;
      work.halo={tiles:[],missing:[]};
      work.haloPlan={offsets:reliefHaloOffsets(z,x,y,sourceZ),index:0,sourceZ,parentX,parentY,files,copies:new Map([[source.url,work.bytes]]),bytes:bytes.byteLength};
      work.stage=work.haloPlan.offsets.length?'halo':'ready';
    }else work.stage='ready';
  }
  private haloDependency(work:Work,offset:ReliefHaloOffset):HaloDependency{
    const plan=work.haloPlan!,tx=canonicalX(plan.parentX+offset.dx,plan.sourceZ),ty=plan.parentY+offset.dy;
    if(ty<0||ty>=2**plan.sourceZ)return{reason:'coverage'};
    const path=`terrain/tiles/${plan.sourceZ}/${tx}/${ty}.png`,local=!!work.local&&!!plan.files?.has(path);
    if(!local&&!navigator.onLine)return{reason:'unavailable'};
    const sourceKey=local?`/offline-map/${path}`:`https://tiles.mapterhorn.com/${plan.sourceZ}/${tx}/${ty}.webp`;
    return{item:{...offset,sourceKey,mime:local?'image/png':'image/webp',...(!local&&work.local?{reduceToArchive:true}:{})}};
  }
  private async fetchHalo(work:Work){
    const plan=work.haloPlan!,halo=work.halo!;
    while(plan.index<plan.offsets.length){
      if(!this.current(work))return;
      const offset=plan.offsets[plan.index],dependency=this.haloDependency(work,offset);
      if('reason' in dependency){halo.missing.push({...offset,reason:dependency.reason});plan.index++;continue;}
      const {item}=dependency,existing=plan.copies.get(item.sourceKey);
      if(existing){halo.tiles.push({...item,bytes:existing});plan.index++;continue;}
      if(plan.bytes>=MAX_TILE_BYTES){halo.missing.push({...offset,reason:'budget'});plan.index++;continue;}
      if(this.reading.has(item.sourceKey)){work.stage='halo';return;}
      try{
        const neighbour=await this.readSource(work,item.sourceKey,1);if(!this.current(work))return;
        if(!neighbour.byteLength)halo.missing.push({...offset,reason:'invalid'});
        else if(plan.bytes+neighbour.byteLength>MAX_TILE_BYTES)halo.missing.push({...offset,reason:'budget'});
        else{const copy=neighbour.slice(0);plan.copies.set(item.sourceKey,copy);plan.bytes+=copy.byteLength;halo.tiles.push({...item,bytes:copy});}
      }catch{if(!this.current(work))return;halo.missing.push({...offset,reason:'unavailable'});}
      plan.index++;
      // One actual neighbour read ends this turn. Other visible primaries and
      // parked DEMs may now use the same three slots before this tile resumes.
      work.stage=plan.index<plan.offsets.length?'halo':'ready';return;
    }
    if(this.current(work))work.stage='ready';
  }
  private finish(work:Work,tile?:CustomMapTile,error?:Error){
    work.bytes=undefined;work.halo=undefined;work.haloPlan=undefined;
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
      this.active=work;work.stage='decoding';const bytes=work.bytes!,halo=work.halo;work.bytes=undefined;work.halo=undefined;work.haloPlan=undefined;
      this.timer=setTimeout(()=>this.failWorker(),15000);
      this.worker.postMessage({id:work.id,kind:work.request.kind==='vector'?'vector':work.request.kind==='relief'?'relief':'raster',bytes,z:work.request.z,x:work.request.x,y:work.request.y,paintZoom:paintZoomFor(work.request),sourceZ:work.sourceZ,sourceKey:work.sourceKey,paths:work.request.paths!==false,transparent:work.request.transparent,boundaries:work.request.boundaries!==false,softwareRaster:this.softwareRaster,mime:work.mime,halo},[...new Set([bytes,...(halo?.tiles.map(item=>item.bytes)??[])])]);
    }catch(error){this.active=undefined;clearTimeout(this.timer);this.finish(work,undefined,error instanceof Error?error:new Error('Map worker unavailable'));}
  }
  private failWorker(message='Map tile worker failed'){
    const work=this.active;this.active=undefined;clearTimeout(this.timer);this.worker?.terminate();this.worker=undefined;
    if(work)this.finish(work,undefined,new Error(message));
  }
  private next(stage:Work['stage'],after?:CustomTileKind){
    // Overview, cartography and elevations arrive as separate batches. FIFO
    // made every DEM wait behind up to 64 vector sources on a cold region.
    // Share the same three HTTP slots across demanded layers from the start.
    const kinds:CustomTileKind[]=['overview','vector','relief','eox-s2','eox-bluemarble'];
    const start=after===undefined?-1:kinds.indexOf(after);
    for(let offset=1;offset<=kinds.length;offset++){
      const kind=kinds[(start+offset)%kinds.length];
      for(const {work} of this.jobs.values())if(work.stage===stage&&work.request.kind===kind&&!(stage==='queued'&&work.source&&this.reading.has(work.source.url)))return work;
    }
  }
  private nextHalo(){
    let first:Work|undefined,after:Work|undefined;
    for(const {work} of this.jobs.values()){
      if(work.stage!=='halo')continue;
      const plan=work.haloPlan!,offset=plan.offsets[plan.index],dependency=offset?this.haloDependency(work,offset):undefined;
      if(dependency&&'item' in dependency&&!plan.copies.has(dependency.item.sourceKey)&&plan.bytes<MAX_TILE_BYTES&&this.reading.has(dependency.item.sourceKey))continue;
      if(!first||work.id<first.id)first=work;
      if(work.id>this.lastHaloWork&&(!after||work.id<after.id))after=work;
    }
    return after??first;
  }
  private pump(){
    if(this.disposed||!this.enabled)return;
    if(!this.active){const ready=this.next('ready',this.lastDecodeKind);if(ready){this.lastDecodeKind=ready.request.kind;this.decode(ready);}}
    while(this.fetching<MAX_FETCHING){
      // Partial DEMs retain the same bounded payload as ready tiles. Starting
      // a new primary needs a free slot; advancing an admitted halo does not.
      const prepared=[...this.jobs.values()].filter(({work})=>work.stage==='fetching'||work.stage==='halo'||work.stage==='ready').length;
      const primary=prepared<MAX_READY?this.next('queued',this.lastFetchKind):undefined;
      const work=primary??this.nextHalo();if(!work)break;
      const halo=work.stage==='halo';if(halo)this.lastHaloWork=work.id;
      this.lastFetchKind=work.request.kind;work.stage='fetching';this.fetching++;
      void (halo?this.fetchHalo(work):this.fetchPrimary(work)).catch(error=>this.finish(work,undefined,error instanceof Error?error:new Error('Tile download failed')))
        .finally(()=>{this.fetching--;this.pump();});
    }
  }
  destroy(){
    if(this.disposed)return;this.disposed=true;clearTimeout(this.timer);this.worker?.terminate();this.worker=undefined;
    for(const {work} of this.jobs.values()){work.controller.abort();work.bytes=undefined;work.halo=undefined;work.haloPlan=undefined;work.reject(new Error('Map resources released'));}
    this.jobs.clear();for(const tile of this.cache.values())tile.bitmap.close();this.cache.clear();this.pinned.clear();this.active=undefined;
  }
}
