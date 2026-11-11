import {SATELLITE_PROVIDERS,satelliteSourceForBounds,type SatelliteBounds} from './map-satellite.ts';

/** A small centre-first plan at the renderer's actual native raster zoom.
 * Iteration stays bounded even if a corrupt/very wide viewport reaches here. */
export function satelliteWarmupPlan(bounds:SatelliteBounds,nativeZoom:number,budget=8):string[] {
  if(![bounds.west,bounds.east,bounds.south,bounds.north,nativeZoom].every(Number.isFinite)||Math.abs(bounds.west)>1080||Math.abs(bounds.east)>1080||bounds.south>bounds.north||!Number.isSafeInteger(budget)||budget<1||budget>16)return [];
  const provider=SATELLITE_PROVIDERS[satelliteSourceForBounds(bounds)],z=Math.max(0,Math.min(provider.maxzoom,Math.round(nativeZoom))),n=2**z;
  let east=bounds.east;
  if(east<bounds.west)east+=360*Math.ceil((bounds.west-east)/360);
  const west=bounds.west,width=Math.min(360,east-west),centerX=(west+width/2+180)/360*n;
  const tileY=(lat:number)=>(1-Math.asinh(Math.tan(Math.max(-85.05112878,Math.min(85.05112878,lat))*Math.PI/180))/Math.PI)/2*n;
  const top=Math.max(0,Math.floor(tileY(bounds.north))),bottom=Math.min(n-1,Math.floor(tileY(bounds.south)));
  const left=Math.floor((west+180)/360*n),right=Math.floor((west+width+180)/360*n),centerY=(top+bottom)/2;
  const radius=Math.ceil(Math.sqrt(budget)),tiles=new Map<string,{x:number;y:number;distance:number}>();
  for(let y=Math.max(top,Math.floor(centerY)-radius);y<=Math.min(bottom,Math.ceil(centerY)+radius);y++){
    for(let x=Math.max(left,Math.floor(centerX)-radius);x<=Math.min(right,Math.ceil(centerX)+radius);x++){
      const wrapped=((x%n)+n)%n,key=`${wrapped}/${y}`,distance=(x+.5-centerX)**2+(y+.5-centerY)**2;
      if(!tiles.has(key)||tiles.get(key)!.distance>distance)tiles.set(key,{x:wrapped,y,distance});
    }
  }
  return [...tiles.values()].sort((a,b)=>a.distance-b.distance).slice(0,budget).map(({x,y})=>provider.tiles.replace('{z}',String(z)).replace('{x}',String(x)).replace('{y}',String(y)));
}

function loadImage(url:string,signal:AbortSignal):Promise<void> {
  return new Promise((resolve,reject)=>{
    const image=new Image();image.crossOrigin='anonymous';image.decoding='async';
    const cleanup=()=>{image.onload=null;image.onerror=null;signal.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();image.src='';reject(new DOMException('Imagery preview cancelled.','AbortError'));};
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    image.onload=()=>{cleanup();resolve();};
    image.onerror=()=>{cleanup();reject(new Error('Imagery preview unavailable.'));};
    image.src=url;
  });
}

/** Intent-only prewarm: at most two requests, eight queued URLs and no retained
 * decoded images. It uses the same anonymous image cache as both renderers. */
export class SatelliteViewWarmup {
  private controller:AbortController|undefined;
  private readonly cached=new Map<string,number>();
  private generation=0;
  private disposed=false;
  private planKey='';
  private load:(url:string,signal:AbortSignal)=>Promise<void>;
  constructor(load=loadImage){this.load=load;}
  warm(bounds:SatelliteBounds,nativeZoom:number):void {
    if(this.disposed||typeof navigator!=='undefined'&&(navigator.onLine===false||(navigator as Navigator&{connection?:{saveData?:boolean;effectiveType?:string}}).connection?.saveData||/^(slow-)?2g$/.test((navigator as Navigator&{connection?:{effectiveType?:string}}).connection?.effectiveType??'')))return;
    const plan=satelliteWarmupPlan(bounds,nativeZoom),key=plan.join('|');
    if(key===this.planKey)return;
    this.planKey=key;this.controller?.abort();
    const controller=new AbortController(),generation=++this.generation;this.controller=controller;
    const pending=plan.filter(url=>!this.cached.has(url)||Date.now()-this.cached.get(url)!>120_000);
    let next=0;
    const timer=setTimeout(()=>controller.abort(),8000);
    const worker=async()=>{
      while(!this.disposed&&!controller.signal.aborted&&generation===this.generation&&next<pending.length){
        const url=pending[next++];
        try{await this.load(url,controller.signal);if(!controller.signal.aborted){this.cached.delete(url);this.cached.set(url,Date.now());while(this.cached.size>32)this.cached.delete(this.cached.keys().next().value!);}}
        catch{/* Optional warmup never changes the map's real readiness/error state. */}
      }
    };
    void Promise.all([worker(),worker()]).finally(()=>{clearTimeout(timer);if(generation===this.generation)this.planKey='';});
  }
  dispose():void{this.disposed=true;this.generation++;this.controller?.abort();this.cached.clear();}
}
