import type * as Leaflet from 'leaflet';
import {loadPublicBytes} from './map-preload';

const MAX_JOBS=48,MAX_FETCHES=3,MAX_TILE_BYTES=2*1024*1024,MAX_BUFFERED_BYTES=8*1024*1024,WORKER_TIMEOUT_MS=10000;
type Job={id:number;canvas:HTMLCanvasElement;done:Leaflet.DoneCallback;cancelled:boolean;url:string;y:number;z:number;overview:boolean;stage:'pending'|'fetching'|'ready'|'working';bytes?:ArrayBuffer};
type WorkerResult={id:number;error?:string;pixels:Uint8ClampedArray;width:number;height:number};

/** One decode at a time. Unloading a tile never frees its active worker slot
 * before a result or timeout; pending downloads and encoded bytes are bounded. */
export function createCanvasRelief(L:typeof Leaflet,onState:(ready:boolean)=>void){
  let worker:Worker|undefined,serial=0,disposed=false,overview=true,fetching=0,bufferedBytes=0,pumpQueued=false;
  let active:Job|undefined,activeTimer:ReturnType<typeof setTimeout>|undefined;
  const jobs=new Map<number,Job>(),unloaded=new WeakSet<HTMLElement>();
  function releaseBytes(job:Job){if(job.bytes){bufferedBytes-=job.bytes.byteLength;job.bytes=undefined;}}
  function queuePump(){
    if(disposed||pumpQueued)return;pumpQueued=true;
    queueMicrotask(()=>{pumpQueued=false;if(!disposed)pump();});
  }
  function finish(job:Job,error?:Error){
    if(jobs.get(job.id)!==job)return;
    jobs.delete(job.id);releaseBytes(job);
    if(!disposed&&!job.cancelled){
      job.canvas.dataset.reliefState=error?'unavailable':'ready';
      if(error)onState(false);
      try{job.done(error,job.canvas);}finally{queuePump();}
    }else queuePump();
  }
  function clearActiveTimer(){if(activeTimer!==undefined)clearTimeout(activeTimer);activeTimer=undefined;}
  function stopWorker(){
    clearActiveTimer();const previous=worker;worker=undefined;active=undefined;
    if(previous){previous.onmessage=null;previous.onerror=null;previous.terminate();}
  }
  function failWorker(){
    stopWorker();
    for(const job of [...jobs.values()])finish(job,new Error('Relief worker unavailable'));
  }
  function startWorker(){
    if(worker)return worker;
    const current=new Worker(new URL('./canvas-relief.worker.ts',import.meta.url),{type:'module',name:'tropnik-map-relief'});worker=current;
    current.onmessage=(event:MessageEvent<WorkerResult>)=>{
      if(disposed||worker!==current||!active||event.data.id!==active.id)return;
      const result=event.data,job=active;active=undefined;clearActiveTimer();
      if(job.cancelled||jobs.get(job.id)!==job){queuePump();return;}
      try{
        if(result.error)throw new Error(result.error);
        if(result.width!==256||result.height!==256||result.pixels?.length!==256*256*4)throw new Error('Invalid relief result');
        const context=job.canvas.getContext('2d');if(!context)throw new Error('Relief canvas unavailable');
        context.putImageData(new ImageData(new Uint8ClampedArray(result.pixels),result.width,result.height),0,0);
        onState(true);finish(job);
      }catch{finish(job,new Error('Relief tile unavailable'));}
      finally{queuePump();}
    };
    current.onerror=()=>{if(worker===current&&!disposed)failWorker();};
    return current;
  }
  function decode(job:Job){
    const bytes=job.bytes;if(!bytes)return;
    releaseBytes(job);job.stage='working';active=job;
    try{
      const current=startWorker(),copy=bytes.slice(0);
      activeTimer=setTimeout(()=>{if(worker===current&&active===job&&!disposed)failWorker();},WORKER_TIMEOUT_MS);
      current.postMessage({id:job.id,bytes:copy,y:job.y,z:job.z,overview:job.overview},[copy]);
    }catch{failWorker();}
  }
  function fetchJob(job:Job){
    job.stage='fetching';fetching++;
    // Priority 0 is the current map, ahead of speculative route previews.
    void loadPublicBytes(job.url,0).then(bytes=>{
      if(disposed||job.cancelled||jobs.get(job.id)!==job)return;
      if(!bytes.byteLength||bytes.byteLength>MAX_TILE_BYTES)throw new Error('Elevation tile exceeds the byte budget');
      job.bytes=bytes;bufferedBytes+=bytes.byteLength;job.stage='ready';
    }).catch(()=>finish(job,new Error('Elevation data unavailable')))
      .finally(()=>{fetching--;queuePump();});
  }
  function pump(){
    if(!active){const ready=[...jobs.values()].find(job=>job.stage==='ready');if(ready)decode(ready);}
    // Reserve a worst-case byte budget for every in-flight download. A slow
    // decoder cannot turn a viewport full of tiles into an unbounded buffer.
    while(fetching<MAX_FETCHES&&bufferedBytes+(fetching+1)*MAX_TILE_BYTES<=MAX_BUFFERED_BYTES){
      const next=[...jobs.values()].find(job=>job.stage==='pending');if(!next)break;fetchJob(next);
    }
  }
  function immediate(canvas:HTMLCanvasElement,done:Leaflet.DoneCallback,error?:Error){
    queueMicrotask(()=>{
      if(disposed||unloaded.has(canvas))return;
      canvas.dataset.reliefState=error?'unavailable':'skipped';
      if(error)onState(false);done(error,canvas);
    });
  }
  const Relief=L.GridLayer.extend({
    createTile(coords:Leaflet.Coords,done:Leaflet.DoneCallback){
      const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
      const id=++serial;canvas.dataset.reliefJob=String(id);
      const longitude=((coords.x+.5)/2**coords.z)*360-180;
      // The authoritative RF mask above this pane clips foreign portions.
      const latitude=Math.atan(Math.sinh(Math.PI*(1-2*(coords.y+.5)/2**coords.z)))*180/Math.PI;
      if(disposed||latitude<25||coords.y<0||coords.y>=2**coords.z||coords.z>=4&&(longitude<10&&longitude>-160)){
        immediate(canvas,done);return canvas;
      }
      if(jobs.size>=MAX_JOBS){immediate(canvas,done,new Error('Relief queue is full'));return canvas;}
      const x=((coords.x%2**coords.z)+2**coords.z)%2**coords.z;
      jobs.set(id,{id,canvas,done,cancelled:false,url:`https://tiles.mapterhorn.com/${coords.z}/${x}/${coords.y}.webp`,
        y:coords.y,z:coords.z,overview,stage:'pending'});queuePump();return canvas;
    },
  }) as {new(options:Leaflet.GridLayerOptions):Leaflet.GridLayer};
  const layer=new Relief({pane:'russia-relief',className:'tropnik-relief-tiles',tileSize:256,minZoom:5,maxNativeZoom:12,maxZoom:18,keepBuffer:4,updateWhenIdle:false,updateWhenZooming:true,opacity:1}) as Leaflet.GridLayer;
  layer.on('tileunload',(event:Leaflet.TileEvent)=>{
    unloaded.add(event.tile);const id=Number(event.tile.dataset.reliefJob),job=jobs.get(id);if(!job)return;
    job.cancelled=true;jobs.delete(id);releaseBytes(job);
    // An active decode keeps its slot until it replies or its worker is stopped.
    // A shared fetch keeps its reservation until it settles, but starts no stale decode.
    queuePump();
  });
  return {
    layer,
    // Keep already decoded tiles on screen. New tiles use the new colour mode;
    // forcing GridLayer.redraw() here blanked the complete relief during zoom.
    setOverview(next:boolean){overview=next;},
    destroy(){disposed=true;layer.remove();stopWorker();for(const job of jobs.values()){job.cancelled=true;releaseBytes(job);}jobs.clear();},
  };
}
