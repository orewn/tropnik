import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inputOfflineSafetyText,assertOfflineSafetyInput} from '../browser-offline-safety.mjs';

// Run the actual target sampler and pointer scheduler against moving form
// geometry. No local browser or application/storage state injection is used.
const source=await readFile(new URL('../browser-smoke.mjs',import.meta.url),'utf8');
const reader=source.slice(source.indexOf('async function elementPoint('),source.indexOf('async function pointerSelector('));
const scheduler=source.slice(source.indexOf('async function pointerSelector('),source.indexOf('async function closeMapSheet('));
function harness({wrongFocus=false,trustedInput=true}={}){
 const window={},listeners=new Map(),commands=[],taps=[],frames=[720,560,480,480,480];
 let sampled=0,pending=null,scrolls=0;
 const field=id=>({id,tagName:'INPUT',value:'',parentElement:null,getAttribute:()=>null,getAnimations:()=>[],contains:node=>node===fields[id],
  scrollIntoView:()=>{scrolls++;},getBoundingClientRect:()=>({left:35,top:frames[Math.max(0,sampled-1)]-24+(id==='region'?89:0),width:342,height:48})});
 const fields={'route-title':field('route-title'),region:field('region')};
 const document={activeElement:{id:'',tagName:'BODY'},querySelector:selector=>fields[selector.slice(1)],
  elementFromPoint:(x,y)=>Object.values(fields).find(field=>{const r=field.getBoundingClientRect();return x>=r.left&&x<r.left+r.width&&y>=r.top&&y<r.top+r.height;}),
  addEventListener:(type,handler)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(handler);},
  removeEventListener:(type,handler)=>listeners.get(type)?.delete(handler)};
 const emit=(type,target,trusted=true)=>{for(const handler of listeners.get(type)||[])handler({type,target,isTrusted:trusted});};
 const evaluate=async(_cdp,expression)=>{
  const value=new Function('document','window','getComputedStyle','innerWidth','innerHeight','performance',`return ${expression};`)(document,window,()=>({display:'block',visibility:'visible'}),412,915,{now:()=>sampled*100});
  return value===undefined?value:structuredClone(value);
 };
 const waitValue=async(label,read,accept)=>{
  for(let i=0;i<20;i++){
   if(pending&&--pending.remaining===0){document.activeElement=pending.field;emit('focusin',pending.field);pending=null;}
   const value=await read();if(accept(value))return value;
  }
  throw new Error(label);
 };
 const compositorFrame=async()=>{sampled++;assert.ok(sampled<=frames.length,'The target must settle within the supplied compositor frames');};
 const elementPoint=new Function('evaluate',`${reader};return elementPoint;`)(evaluate);
 const pointerAt=async(_cdp,point)=>{
  taps.push({point,sampled});
  const target=wrongFocus?fields.region:document.elementFromPoint(point.x,point.y);
  for(const type of ['pointerdown','pointerup','click'])emit(type,target);
  pending={field:target,remaining:3};
 };
 const pointerSelector=new Function('waitValue','elementPoint','pointerAt','compositorFrame',`${scheduler};return pointerSelector;`)(waitValue,elementPoint,pointerAt,compositorFrame);
 const cdp={call:async(method,params)=>{
  commands.push({method,params,activeId:document.activeElement.id});
  if(method==='Input.insertText'){const field=document.activeElement;emit('beforeinput',field,trustedInput);field.value=params.text;emit('input',field,trustedInput);}
 }};
 return{cdp,helpers:{evaluate,waitValue,pointerSelector},fields,commands,taps,listeners,get scrolls(){return scrolls;}};
}

test('offline form waits for smooth-scroll geometry and delayed native focus before typing into the route field',async()=>{
 const run=harness(),inputs=[],value='CI · Берег Приморска';
 const receipt=await inputOfflineSafetyText(run.cdp,run.helpers,{mobile:true},'#route-title',value,inputs);
 assert.equal(run.scrolls,1);assert.equal(run.taps.length,1);assert.equal(run.taps[0].sampled,5);assert.equal(run.taps[0].point.y,480);
 assert.ok(run.commands.every(command=>command.activeId==='route-title'),'No key or text command may precede the intended native focus');
 assert.equal(run.fields['route-title'].value,value);assert.equal(run.fields.region.value,'');
 assert.equal(assertOfflineSafetyInput(receipt),receipt);assert.equal(inputs.length,1);
 assert.equal(receipt.finalActiveId,'route-title');assert.equal(receipt.finalValueLength,value.length);
 assert.ok([...run.listeners.values()].every(handlers=>handlers.size===0),'Input diagnostics must be removed after completion');
});

test('a native tap that focuses the neighboring region fails before sending any text and preserves the received events',async()=>{
 const run=harness({wrongFocus:true}),inputs=[];
 await assert.rejects(inputOfflineSafetyText(run.cdp,run.helpers,{mobile:true},'#route-title','CI · Берег Приморска',inputs),/did not receive native focus/);
 assert.equal(run.commands.length,0);assert.equal(run.fields.region.value,'');assert.equal(inputs[0].passed,false);
 assert.equal(inputs[0].finalActiveId,'region');assert.ok(inputs[0].events.some(event=>event.type==='focusin'&&event.id==='region'));
 assert.ok([...run.listeners.values()].every(handlers=>handlers.size===0));
});

test('matching text without a trusted input event cannot satisfy the offline form proof',async()=>{
 const run=harness({trustedInput:false}),inputs=[];
 await assert.rejects(inputOfflineSafetyText(run.cdp,run.helpers,{mobile:true},'#route-title','CI · Берег Приморска',inputs),/trusted input event/);
 assert.equal(inputs[0].passed,false);assert.equal(inputs[0].focusedBeforeTyping,true);
});
