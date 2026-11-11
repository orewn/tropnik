import {createRussiaTerrainMask} from './terrain-display-mask';

let started=false;
self.onmessage=async({data}:MessageEvent<{type:string;bounds:number[]}>)=>{
  if(started||data?.type!=='prepare-display-mask')return;started=true;
  try{const mask=await createRussiaTerrainMask(data.bounds);self.postMessage({type:'display-mask-ready',mask},{transfer:[mask.pixels.buffer]});}
  catch(error){self.postMessage({type:'display-mask-error',error:error instanceof Error?error.message:'Landscape mask unavailable'});}
};
