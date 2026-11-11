import type {TerrainDisplayMask} from '../public/terrain/terrain-renderer.js';
import {createRussiaTerrainMask} from './terrain-display-mask';
import maskWorkerURL from './terrain-display-mask.worker.ts?worker&url';

/** One bounded preparation per open scene. Only bounds enter the worker;
 * complete country polygons are never cloned through the main thread. */
export async function prepareLandscapeDisplayMask(bounds:readonly number[],{signal}:{signal?:AbortSignal}={}):Promise<TerrainDisplayMask>{
  if(signal?.aborted)throw signal.reason??new DOMException('Landscape mask cancelled','AbortError');
  let worker:Worker|undefined;
  try{if(typeof Worker!=='undefined')worker=new Worker(new URL(maskWorkerURL,location.href),{type:'module',name:'tropnik-display-area'});}catch{/* Same bounded numeric work remains available in older browsers. */}
  if(!worker){
    const controller=new AbortController(),abort=()=>controller.abort(signal?.reason??new DOMException('Landscape mask cancelled','AbortError'));
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(new Error('Landscape mask preparation timed out')),20_000);
    try{if(signal?.aborted)abort();const mask=await createRussiaTerrainMask(bounds,{signal:controller.signal});if(controller.signal.aborted)throw controller.signal.reason;return mask;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  const target=worker;
  return new Promise((resolve,reject)=>{
    let finished=false;const timer=setTimeout(()=>finish(new Error('Landscape mask preparation timed out')),20_000);
    const abort=()=>finish(signal?.reason??new DOMException('Landscape mask cancelled','AbortError'));
    const finish=(error?:unknown,mask?:TerrainDisplayMask)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);target.onmessage=null;target.onerror=null;target.onmessageerror=null;target.terminate();if(error)reject(error);else resolve(mask!);};
    signal?.addEventListener('abort',abort,{once:true});
    target.onmessage=event=>{const data=event.data;if(data?.type==='display-mask-ready')finish(undefined,data.mask);else finish(new Error(data?.type==='display-mask-error'?String(data.error):'Invalid landscape mask response'));};
    target.onerror=event=>{event.preventDefault?.();finish(new Error(event.message||'Landscape mask worker failed'));};
    target.onmessageerror=()=>finish(new Error('Landscape mask could not be transferred'));
    try{target.postMessage({type:'prepare-display-mask',bounds:[...bounds]});}catch(error){finish(error);}
    if(signal?.aborted)abort();
  });
}
