import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Execute the production native-scroll scheduler with sampled compositor
// progress. These unit boundaries never launch or claim a real browser.
const source=await readFile(new URL('../browser-smoke.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function scrollContainer('),end=source.indexOf('async function revealNative(',start);
assert.ok(start>=0&&end>start);
const scheduler=source.slice(start,end);
const state=scrollTop=>({rect:{left:0,right:384,top:72,bottom:955,width:384,height:883},scrollTop,scrollHeight:1187,clientHeight:883,scrollY:0,sheet:'open'});

function harness(positions,{before=0,current=positions.at(-1)}={}){
 const calls=[],timeouts=[],failure=new Error('Native scroll deadline expired');
 let reads=0,sampled=0,acceptedAt=null,events=[];
 const read=async()=>state(reads++===0?before:positions[sampled]??current);
 const waitValue=async(_label,observe,accept,timeout)=>{
  timeouts.push(timeout);
  for(sampled=0;sampled<positions.length;sampled++){
   const value=await observe();
   if(accept(value)){acceptedAt=sampled+1;return value;}
  }
  throw failure;
 };
 const evaluate=async(_cdp,expression)=>{
  if(expression==='window.__tropnikScrollEvents=[]'){events=[];return events;}
  if(expression==='window.__tropnikScrollEvents')return events;
  assert.match(expression,/contains\(document\.elementFromPoint\(/);return true;
 };
 const cdp={call:async(method,params)=>{
  calls.push({method,...params});
  events.push({type:'wheel',time:100,trusted:true,x:params.x,y:params.y});
 }};
 const scroll=new Function('assert','scrollContainerState','evaluate','waitValue','sleep',`${scheduler};return scrollContainer;`)(assert,read,evaluate,waitValue,async()=>{});
 return{scroll,cdp,calls,timeouts,failure,get acceptedAt(){return acceptedAt;}};
}

test('a queued wheel cannot settle on unchanged pre-scroll samples before its movement arrives',async()=>{
 const run=harness([0,0,0,0,0,240,240,240,240]);
 const receipt=await run.scroll(run.cdp,'.explore-panel-content',{mobile:false});
 assert.equal(run.acceptedAt,9,'All three stable observations must follow actual signed movement');
 assert.deepEqual(run.timeouts,[4000]);
 assert.equal(run.calls.length,1,'Waiting for delivery must not resend the native wheel');
 assert.equal(run.calls[0].type,'mouseWheel');assert.equal(run.calls[0].deltaY,240);
 assert.equal(receipt.before.scrollTop,0);assert.equal(receipt.after.scrollTop,240);
 assert.equal(receipt.events.length,1);assert.equal(receipt.events[0].trusted,true);
});

test('native scroll settling requires progress in the requested direction, including upward scrolling',async()=>{
 const up=harness([240,240,240,240,180,80,0,0,0,0],{before:240});
 const receipt=await up.scroll(up.cdp,'.explore-panel-content',{mobile:false},-1);
 assert.equal(up.acceptedAt,10);assert.equal(up.calls.length,1);assert.equal(up.calls[0].deltaY,-240);
 assert.equal(receipt.after.scrollTop,0);
 const wrong=harness([80,80,80,80,80,80],{before:100});
 const error=await wrong.scroll(wrong.cdp,'.explore-panel-content',{mobile:false}).then(()=>null,error=>error);
 assert.equal(error,wrong.failure);assert.equal(wrong.acceptedAt,null);assert.equal(wrong.calls.length,1);
});

test('zero progress still fails at the original deadline and retains actual commands, samples and later state',async()=>{
 const run=harness(Array(48).fill(0),{current:304});
 const error=await run.scroll(run.cdp,'.explore-panel-content',{mobile:false}).then(()=>null,error=>error);
 assert.equal(error,run.failure,'Diagnostics must preserve the original failure');
 assert.deepEqual(run.timeouts,[4000]);assert.equal(run.calls.length,1);assert.equal(run.acceptedAt,null);
 const audit=error.nativeScroll;
 assert.equal(audit.before.scrollTop,0);assert.equal(audit.after.scrollTop,0);assert.equal(audit.current.scrollTop,304);
 assert.equal(audit.observations.length,16);assert.ok(audit.observations.every(frame=>frame.scrollTop===0));
 assert.deepEqual(audit.commands,[{method:'Input.dispatchMouseEvent',type:'mouseWheel',status:'fulfilled'}]);
 assert.equal(audit.events.length,1);assert.equal(audit.events[0].trusted,true);
 assert.equal(audit.events[0].x,audit.start.x);assert.equal(audit.events[0].y,audit.start.y);
});
