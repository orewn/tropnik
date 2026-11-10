import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Exercise the production input scheduler without launching a local browser.
const source=await readFile(new URL('../browser-smoke.mjs',import.meta.url),'utf8');
const scheduler=source.slice(source.indexOf('async function pointerSelector('),source.indexOf('async function closeMapSheet('));
function harness(frames){
 const taps=[];let sampled=0,painted=0;
 const waitValue=async(label,read,accept)=>{for(let i=0;i<frames.length;i++){const value=await read();if(accept(value))return value;}throw new Error(label);};
 const frame=async()=>{painted++;};
 const read=async()=>{assert.equal(painted,sampled+1,'Every target sample follows a real compositor-frame boundary');return frames[sampled++];};
 const tap=async(_cdp,point)=>{taps.push({sampled,point});};
 const select=new Function('waitValue','elementPoint','pointerAt','compositorFrame',`${scheduler};return pointerSelector;`)(waitValue,read,tap,frame);
 return{select,taps};
}
const point=(y,unobscured=true,animating=false)=>({x:100,y,width:180,height:44,unobscured,animating});

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

test('a stable pre-animation rectangle cannot receive the one native click before the dialog finishes moving',async()=>{
 const run=harness([point(298,true,true),point(298,true,true),point(298,true,true),point(286,true,true),point(274),point(274),point(274)]);
 const target=await run.select({},'[role="dialog"] button[aria-label="Закрыть"]',{mobile:false});
 assert.equal(run.taps.length,1,'No premature input or retry may be sent');
 assert.equal(run.taps[0].sampled,7);assert.equal(target.y,274);assert.equal(target.animating,false);
});

test('an animation that never becomes idle fails without a click and retains a bounded sample history',async()=>{
 const run=harness(Array.from({length:48},()=>point(298,true,true)));
 const error=await run.select({},'[role="dialog"] button[aria-label="Закрыть"]',{mobile:false}).then(()=>null,error=>error);
 assert.match(error.message,/stable and unobscured/);assert.equal(run.taps.length,0);
 assert.equal(error.pointerTarget.samples.length,16);assert.ok(error.pointerTarget.samples.every(sample=>sample.animating));
 assert.equal(error.pointerTarget.requiredIdleObservations,3);assert.equal(error.pointerTarget.geometryTolerancePx,.25);
});

test('the production DOM probe observes pending and running ancestor animations and accepts their finished state',async()=>{
 const reader=source.slice(source.indexOf('async function elementPoint('),source.indexOf('async function pointerSelector('));
 let top=276;
 const animation={animationName:'field-dialog',pending:true,playState:'running',currentTime:0};
 const dialog={tagName:'DIV',parentElement:null,getAttribute:()=> 'modal',getAnimations:()=>[animation]};
 const button={tagName:'BUTTON',parentElement:dialog,getAnimations:()=>[],getAttribute:name=>name==='aria-label'?'Закрыть':'icon-button',getBoundingClientRect:()=>({left:893,top,width:44,height:44}),contains:node=>node===button};
 const doc={querySelector:()=>button,elementFromPoint:()=>button};
 const evaluate=async(_cdp,expression)=>new Function('document','getComputedStyle','innerWidth','innerHeight','performance',`return ${expression};`)(doc,()=>({display:'block',visibility:'visible'}),1440,1000,{now:()=>1000});
 const read=new Function('evaluate',`${reader};return elementPoint;`)(evaluate);
 let observed=await read({},'button');
 assert.equal(observed.y,298);assert.equal(observed.animating,true);assert.equal(observed.animations[0].classes,'modal');assert.equal(observed.animations[0].pending,true);
 animation.pending=false;animation.currentTime=100;
 observed=await read({},'button');assert.equal(observed.animating,true,'A started but unfinished ancestor still moves the target');
 animation.playState='finished';animation.currentTime=500;top=252;
 observed=await read({},'button');assert.equal(observed.y,274);assert.equal(observed.animating,false);assert.deepEqual(observed.animations,[]);
});
