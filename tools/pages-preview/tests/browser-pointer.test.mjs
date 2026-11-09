import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Exercise the production input scheduler without launching a local browser.
const source=await readFile(new URL('../browser-smoke.mjs',import.meta.url),'utf8');
const scheduler=source.slice(source.indexOf('async function pointerSelector('),source.indexOf('async function closeMapSheet('));
function harness(frames){
 const taps=[];let sampled=0;
 const waitValue=async(label,read,accept)=>{for(let i=0;i<frames.length;i++){const value=await read();if(accept(value))return value;}throw new Error(label);};
 const read=async()=>frames[sampled++];
 const tap=async(_cdp,point)=>{taps.push({sampled,point});};
 const select=new Function('waitValue','elementPoint','pointerAt',`${scheduler};return pointerSelector;`)(waitValue,read,tap);
 return{select,taps};
}
const point=(y,unobscured=true)=>({x:100,y,width:180,height:44,unobscured});

test('a real pointer is sent once only after the moving sheet target settles and becomes reachable',async()=>{
 const moving=harness([point(840),point(650),point(470),point(470),point(470)]);
 await moving.select({},'.back-link',{mobile:true});
 assert.equal(moving.taps.length,1);
 assert.equal(moving.taps[0].sampled,5);
 assert.equal(moving.taps[0].point.y,470);
 const covered=harness([point(470,false),point(470,false),point(470),point(470),point(470)]);
 await covered.select({},'.back-link',{mobile:true});
 assert.equal(covered.taps.length,1);
 assert.equal(covered.taps[0].sampled,5);
 const blocked=harness([point(470,false),point(470,false),point(470,false)]);
 await assert.rejects(blocked.select({},'.back-link',{mobile:true}),/stable and unobscured/);
 assert.equal(blocked.taps.length,0);
});
