import trailRasterWorkerURL from './custom-map-trail-raster.worker.ts?worker&url';

/** A part keeps one immutable identity for its interleaved projected world X/Y.
 * The caller retains its array; only a private copy is transferred to a worker. */
export type TrailRasterPart={id:number;points:Float64Array};
export type TrailRasterFrame={
  parts:readonly TrailRasterPart[];
  width:number;height:number;
  transform:readonly [number,number,number,number,number,number];
  haloWidth:number;lineWidth:number;haloColor:string;lineColor:string;
};
export type TrailRasterSnapshot={key:string;bitmap:ImageBitmap;width:number;height:number};
export type TrailRasterState={ready:boolean;pending:boolean;error:string};
export type TrailRasterWorkerRequest={
  id:number;width:number;height:number;transform:readonly number[];
  haloWidth:number;lineWidth:number;haloColor:string;lineColor:string;softwareRaster:boolean;
  partIds:number[];addParts:TrailRasterPart[];dropPartIds:number[];
};
type WorkerReply={id:number;bitmap?:ImageBitmap;error?:string};
type Options={onChange:()=>void;softwareRaster?:boolean;createWorker?:()=>Worker;timeoutMs?:number};
type Geometry={key:string;ids:number[];parts:TrailRasterPart[];bytes:number};
type PreparedFrame=Omit<TrailRasterFrame,'parts'>&{key:string;geometry:Geometry;bytes:number};
type Entry={frame:PreparedFrame;snapshot:TrailRasterSnapshot};
type Work={id:number;frame:PreparedFrame};

export const TRAIL_RASTER_LIMITS=Object.freeze({
  bitmapBytes:64*1024*1024,entries:3,frameBytes:32*1024*1024,
  sourceBytes:32*1024*1024,parts:100000,dimension:16384,timeoutMs:15000,
});
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/** One worker, one native paint in flight and one replaceable latest request.
 * A frame is published only under its exact geometry, style and backing matrix.
 * Registered parts and decoded worker paths follow the bounded frame cache. */
export class CustomMapTrailRaster {
  private worker?:Worker;
  private active?:Work;
  private latest?:PreparedFrame;
  private desired?:PreparedFrame;
  private timer?:ReturnType<typeof setTimeout>;
  private serial=0;
  private disposed=false;
  private notification=false;
  private error='';
  private failedKey?:string;
  private invalidError='';
  private bytes=0;
  private cache=new Map<string,Entry>();
  private geometry=new WeakMap<readonly TrailRasterPart[],Geometry>();
  private registered=new Map<number,TrailRasterPart>();
  private closed=new WeakSet<object>();
  private timeoutMs:number;

  constructor(private readonly options:Options){
    const timeout=options.timeoutMs??TRAIL_RASTER_LIMITS.timeoutMs;
    this.timeoutMs=Number.isFinite(timeout)&&timeout>0?Math.min(timeout,TRAIL_RASTER_LIMITS.timeoutMs):TRAIL_RASTER_LIMITS.timeoutMs;
  }
  getState():TrailRasterState {
    const ready=!!this.desired&&this.cache.has(this.desired.key);
    return{ready,pending:!!this.desired&&!ready&&!this.error&&!this.disposed,error:this.error};
  }
  request(frame:TrailRasterFrame):TrailRasterSnapshot|undefined {
    if(this.disposed)return;
    let prepared:PreparedFrame;
    try{prepared=this.prepare(frame);}
    catch(error){
      const next='Trail overlay raster: '+message(error),changed=this.invalidError!==next;
      this.desired=undefined;this.latest=undefined;this.failedKey=undefined;this.invalidError=next;this.error=next;
      if(changed)this.notify();return;
    }
    this.invalidError='';
    if(this.desired?.key!==prepared.key){this.error='';this.failedKey=undefined;}
    this.desired=prepared;
    const cached=this.cache.get(prepared.key);
    if(cached){
      this.cache.delete(prepared.key);this.cache.set(prepared.key,cached);
      this.latest=undefined;this.error='';this.failedKey=undefined;return cached.snapshot;
    }
    if(this.failedKey===prepared.key)return;
    if(this.active){this.latest=this.active.frame.key===prepared.key?undefined:prepared;return;}
    this.latest=undefined;this.dispatch(prepared);return;
  }
  /** Hiding paths invalidates pending publication without losing reusable frames. */
  clear(){this.desired=undefined;this.latest=undefined;this.error='';this.failedKey=undefined;this.invalidError='';}
  retry(){
    if(this.disposed)return;
    this.error='';this.failedKey=undefined;this.invalidError='';
    const frame=this.desired;
    if(frame&&!this.cache.has(frame.key)){
      if(this.active)this.latest=this.active.frame.key===frame.key?undefined:frame;
      else this.dispatch(frame);
    }
    this.notify();
  }
  destroy(){
    if(this.disposed)return;this.disposed=true;
    clearTimeout(this.timer);this.timer=undefined;this.worker?.terminate();this.worker=undefined;
    this.active=undefined;this.latest=undefined;this.desired=undefined;
    for(const entry of this.cache.values())this.close(entry.snapshot.bitmap);
    this.cache.clear();this.bytes=0;this.registered.clear();this.geometry=new WeakMap();this.error='';
  }

  private notify(){
    if(this.notification||this.disposed)return;this.notification=true;
    queueMicrotask(()=>{this.notification=false;if(!this.disposed)this.options.onChange();});
  }
  private close(bitmap:ImageBitmap|undefined){
    if(!bitmap||typeof bitmap!=='object'||this.closed.has(bitmap))return;
    this.closed.add(bitmap);try{bitmap.close();}catch{}
  }
  private evict(key:string){
    const entry=this.cache.get(key);if(!entry)return;
    this.cache.delete(key);this.bytes-=entry.frame.bytes;this.close(entry.snapshot.bitmap);
  }
  private prepare(frame:TrailRasterFrame):PreparedFrame {
    const {width,height,transform,haloWidth,lineWidth,haloColor,lineColor}=frame;
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0||width>TRAIL_RASTER_LIMITS.dimension||height>TRAIL_RASTER_LIMITS.dimension)throw new Error('Invalid backing dimensions');
    const bytes=width*height*4;
    if(bytes>TRAIL_RASTER_LIMITS.frameBytes)throw new Error('Backing frame exceeds the 32 MiB budget');
    if(!Array.isArray(transform)||transform.length!==6||!transform.every(Number.isFinite)||!Number.isFinite(transform[0]*transform[3]-transform[1]*transform[2])||transform[0]*transform[3]===transform[1]*transform[2])throw new Error('Invalid world-to-backing transform');
    if(![haloWidth,lineWidth].every(value=>Number.isFinite(value)&&value>0)||haloWidth<lineWidth)throw new Error('Invalid trail stroke widths');
    if(![haloColor,lineColor].every(value=>typeof value==='string'&&value.length>0&&value.length<=128))throw new Error('Invalid trail colors');
    let geometry=this.geometry.get(frame.parts);
    if(!geometry){
      if(!Array.isArray(frame.parts)||frame.parts.length>TRAIL_RASTER_LIMITS.parts)throw new Error('Trail part budget exceeded');
      const parts=new Map<number,TrailRasterPart>(),ids:number[]=[];let size=0;
      for(const part of frame.parts){
        if(!Number.isSafeInteger(part.id)||part.id<=0||!(part.points instanceof Float64Array)||part.points.length<4||part.points.length%2)throw new Error('Invalid projected trail part');
        const previous=parts.get(part.id);
        if(previous&&previous.points!==part.points||this.registered.has(part.id)&&this.registered.get(part.id)!.points!==part.points)throw new Error('A trail part identity changed');
        if(!previous){
          size+=part.points.byteLength;if(size>TRAIL_RASTER_LIMITS.sourceBytes)throw new Error('Projected trail sources exceed the 32 MiB budget');
          if(!part.points.every(Number.isFinite))throw new Error('Invalid projected trail coordinate');
          parts.set(part.id,part);
        }
        ids.push(part.id);
      }
      geometry={key:ids.join(','),ids,parts:[...parts.values()],bytes:size};this.geometry.set(frame.parts,geometry);
    }
    const matrix:TrailRasterFrame['transform']=[transform[0],transform[1],transform[2],transform[3],transform[4],transform[5]];
    const key=geometry.key+'|'+JSON.stringify([width,height,matrix,haloWidth,lineWidth,haloColor,lineColor]);
    const cached=this.cache.get(key)?.frame.geometry;
    if(cached&&cached!==geometry&&cached.parts.some((part,index)=>part.id!==geometry!.parts[index]?.id||part.points!==geometry!.parts[index]?.points))throw new Error('A cached trail part identity changed');
    return{key,geometry,width,height,transform:matrix,haloWidth,lineWidth,haloColor,lineColor,bytes};
  }
  private ensureWorker(){
    if(this.worker)return this.worker;
    const worker=this.options.createWorker?.()??new Worker(new URL(trailRasterWorkerURL,location.href),{type:'module',name:'tropnik-trail-overlay'});
    this.worker=worker;
    worker.onmessage=(event:MessageEvent<WorkerReply>)=>this.receive(worker,event.data);
    worker.onerror=event=>{if(this.worker===worker)this.failWorker('Worker failed: '+(event.message||'Unknown worker error'));};
    worker.onmessageerror=()=>{if(this.worker===worker)this.failWorker('Worker message could not be decoded');};
    return worker;
  }
  private retained(frame:PreparedFrame){
    const collect=()=>{
      const parts=new Map<number,TrailRasterPart>();let bytes=0;
      for(const geometry of [frame.geometry,...[...this.cache.values()].map(entry=>entry.frame.geometry)])for(const part of geometry.parts){
        const previous=parts.get(part.id)??this.registered.get(part.id);
        if(previous&&previous.points!==part.points)throw new Error('A registered trail part identity changed');
        if(!parts.has(part.id)){parts.set(part.id,part);bytes+=part.points.byteLength;}
      }
      return{parts,bytes};
    };
    let result=collect();
    while((result.bytes>TRAIL_RASTER_LIMITS.sourceBytes||result.parts.size>TRAIL_RASTER_LIMITS.parts)&&this.cache.size){this.evict(this.cache.keys().next().value!);result=collect();}
    if(result.bytes>TRAIL_RASTER_LIMITS.sourceBytes||result.parts.size>TRAIL_RASTER_LIMITS.parts)throw new Error('Retained trail sources exceed their budget');
    return result.parts;
  }
  private dispatch(frame:PreparedFrame){
    if(this.disposed||this.active||this.desired?.key!==frame.key)return;
    try{
      const retained=this.retained(frame),worker=this.ensureWorker();
      const dropPartIds=[...this.registered.keys()].filter(id=>!retained.has(id));
      const addParts:TrailRasterPart[]=[],transfer:ArrayBuffer[]=[];
      for(const part of frame.geometry.parts)if(!this.registered.has(part.id)){
        const points=part.points.slice();addParts.push({id:part.id,points});transfer.push(points.buffer as ArrayBuffer);
      }
      for(const id of dropPartIds)this.registered.delete(id);
      for(const part of frame.geometry.parts)this.registered.set(part.id,part);
      const id=++this.serial;
      this.active={id,frame};
      this.timer=setTimeout(()=>{if(this.active?.id===id)this.failWorker('Worker paint exceeded its deadline');},this.timeoutMs);
      const payload:TrailRasterWorkerRequest={id,width:frame.width,height:frame.height,transform:frame.transform,haloWidth:frame.haloWidth,lineWidth:frame.lineWidth,haloColor:frame.haloColor,lineColor:frame.lineColor,softwareRaster:!!this.options.softwareRaster,partIds:frame.geometry.ids,addParts,dropPartIds};
      worker.postMessage(payload,transfer);
    }catch(error){this.failWorker(message(error));}
  }
  private receive(worker:Worker,reply:WorkerReply){
    const work=this.active;
    if(this.disposed||this.worker!==worker||!work||reply?.id!==work.id){this.close(reply?.bitmap);return;}
    clearTimeout(this.timer);this.timer=undefined;this.active=undefined;
    const current=this.desired?.key===work.frame.key;
    if(reply.bitmap&&reply.bitmap.width===work.frame.width&&reply.bitmap.height===work.frame.height&&!reply.error){
      if(current){
        const snapshot={key:work.frame.key,bitmap:reply.bitmap,width:work.frame.width,height:work.frame.height};
        this.evict(work.frame.key);this.cache.set(work.frame.key,{frame:work.frame,snapshot});this.bytes+=work.frame.bytes;
        while(this.cache.size>TRAIL_RASTER_LIMITS.entries||this.bytes>TRAIL_RASTER_LIMITS.bitmapBytes)this.evict(this.cache.keys().next().value!);
        this.error='';this.failedKey=undefined;this.notify();
      }else this.close(reply.bitmap);
    }else{
      this.close(reply.bitmap);
      worker.terminate();this.worker=undefined;this.registered.clear();
      if(current){this.error='Trail overlay raster: '+(reply.error||'Worker returned an invalid bitmap');this.failedKey=work.frame.key;this.notify();}
    }
    const next=this.latest;this.latest=undefined;
    if(next&&this.desired?.key===next.key&&!this.cache.has(next.key)&&this.failedKey!==next.key)this.dispatch(next);
  }
  private failWorker(reason:string){
    clearTimeout(this.timer);this.timer=undefined;this.worker?.terminate();this.worker=undefined;
    this.active=undefined;this.latest=undefined;this.registered.clear();
    if(this.desired&&!this.cache.has(this.desired.key)){
      this.error='Trail overlay raster: '+reason;this.failedKey=this.desired.key;this.notify();
    }
  }
}
