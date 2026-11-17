import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Exercise the capture barrier's production DOM probe and scheduler. The live
// browser still supplies the transition, rectangles and final map pixels.
const source=await readFile(new URL('../browser-trail-overlay.mjs',import.meta.url),'utf8');
const scheduler=source.slice(source.indexOf('async function settledClosedSheet('),source.indexOf('async function pointer('));
const sample=(top,extra={})=>({state:'closed',top,width:390,height:620,animations:[],ancestorAnimations:[],...extra});
function harness(samples){
  const deadline=new Error('Sheet capture readiness deadline expired'),observations=[],timeouts=[];let index=0;
  const evaluate=async(_cdp,expression)=>{
    const current=samples[index++];
    const root={dataset:{sheetState:current.state,sheetDragging:String(!!current.dragging)},parentElement:null,getAnimations:()=>current.ancestorAnimations};
    const panel={dataset:{},parentElement:root,getAnimations:()=>current.animations,getBoundingClientRect:()=>({left:current.left??0,top:current.top,width:current.width,height:current.height})};
    const document={querySelector:selector=>selector==='.explore-layout'?root:selector==='.explore-panel'?panel:null};
    const observed=new Function('document',`return ${expression};`)(document);observations.push(observed);return observed;
  };
  const waitValue=async(label,read,accept,timeout)=>{
    assert.equal(label,'closed trail-overlay sheet before capture');timeouts.push(timeout);
    for(let i=0;i<samples.length;i++){const current=await read();if(accept(current))return current;}
    throw deadline;
  };
  const settle=new Function('evaluate','waitValue',`${scheduler};return settledClosedSheet;`)(evaluate,waitValue);
  return{settle,observations,timeouts,deadline};
}

test('capture waits past the closed flag and pending/running transitions for three physical endpoint observations',async()=>{
  const pending={pending:true,playState:'idle'},running={pending:false,playState:'running'},finished={pending:false,playState:'finished'};
  const run=harness([
    sample(190,{state:'open'}),
    sample(190,{animations:[pending]}),sample(190,{animations:[pending]}),sample(190,{animations:[pending]}),
    sample(390,{ancestorAnimations:[running]}),
    sample(676,{animations:[finished]}),sample(676),sample(676),
  ]);
  const settled=await run.settle({});
  assert.equal(run.observations.length,8);assert.equal(settled.state,'closed');assert.equal(settled.rect.top,676);assert.equal(settled.animating,false);
  assert.deepEqual(run.timeouts,[4000]);
});

test('late movement or a new pending transition restarts endpoint observation',async()=>{
  const pending={pending:true,playState:'idle'};
  const run=harness([sample(670),sample(670),sample(676),sample(676),sample(676,{animations:[pending]}),sample(676),sample(676),sample(676)]);
  await run.settle({});assert.equal(run.observations.length,8);
});

test('an unfinished transition, drag or nonvisible panel exhausts the same bounded capture deadline',async()=>{
  for(const current of [sample(676,{animations:[{pending:false,playState:'running'}]}),sample(676,{dragging:true}),sample(676,{height:0}),sample(190,{state:'open'})]){
    const run=harness(Array.from({length:8},()=>current));
    await assert.rejects(run.settle({}),error=>error===run.deadline);
    assert.deepEqual(run.timeouts,[4000]);assert.equal(run.observations.length,8);
  }
});

test('the selected screenshot follows native close, the sheet barrier and the original map readiness gate',()=>{
  const begin=source.indexOf("assert.ok(witness.acceptableIds.includes(result.selected.routeId)");
  const end=source.indexOf("const options=",begin),capture=source.slice(begin,end);
  const steps=["await pointerSelector(cdp,profile,'.sheet-handle')",'if(profile.mobile)await settledClosedSheet(cdp)',"result.selected=await waitValue('selected route after panel transition'","stable(value)&&value.routeId===result.selected.routeId","await screenshot(cdp,profile,'selected')"];
  let previous=-1;
  for(const step of steps){const at=capture.indexOf(step);assert.ok(at>previous,`Capture ordering lost: ${step}`);previous=at;}
});
