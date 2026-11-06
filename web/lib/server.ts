import {cache} from 'react';
import type {Route} from './contract';
import {publishedTrail} from './route-adapter';
// An unavailable configured API must never be mistaken for a missing route (404).
async function read<T>(path:string):Promise<T|null>{
 const base=process.env.TROPA_API_URL;if(!base)return null;
 const url=new URL(base);
 if(url.username||url.password||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]','api'].includes(url.hostname))throw new Error('Invalid API configuration');
 url.pathname=url.pathname.replace(/\/$/,'')+'/api/v1/'+path;url.search='';
 const res=await fetch(url,{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(6000)});
 if(res.status===404)return null;
 if(!res.ok)throw new Error('Route service temporarily unavailable');
 const body=await res.json() as{data:T};if(!body||!('data'in body))throw new Error('Incomplete route response');return body.data;
}
export const getPublishedTrails=cache(async()=>{const routes=await read<Route[]>('routes');return(routes||[]).map(publishedTrail);});
export const getPublishedTrail=cache(async(id:string)=>{if(!/^[\w-]{1,128}$/.test(id))return undefined;const route=await read<Route>(`routes/${encodeURIComponent(id)}`);return route?publishedTrail(route):undefined;});
