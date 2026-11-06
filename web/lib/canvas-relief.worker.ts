import {shadeTerrarium} from '@/public/maps/relief-shading.js';

self.onmessage = async (event:MessageEvent<{id:number;bytes:ArrayBuffer;y:number;z:number;overview:boolean}>) => {
  const {id,bytes,y,z,overview}=event.data;
  let bitmap:ImageBitmap|undefined;
  try {
    bitmap=await createImageBitmap(new Blob([bytes],{type:'image/webp'}));
    if(bitmap.width!==512||bitmap.height!==512)throw new Error('Unexpected elevation tile dimensions');
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context)throw new Error('Elevation decoder unavailable');
    context.drawImage(bitmap,0,0);bitmap.close();bitmap=undefined;
    const image=context.getImageData(0,0,canvas.width,canvas.height);
    const result=shadeTerrarium(image.data,image.width,image.height,y,z,overview);
    self.postMessage({id,...result},{transfer:[result.pixels.buffer]});
  } catch {self.postMessage({id,error:'Relief tile unavailable'});}
  finally{bitmap?.close();}
};
