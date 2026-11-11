import {SMOOTHNESS_SCENARIOS,summarizeSmoothness} from '../browser-smoothness.mjs';

export function smoothnessWindowFixture(name='panel'){
 return summarizeSmoothness({schemaVersion:1,name,startedAt:100,endedAt:300,supported:{longtask:true,event:true,'layout-shift':true},errors:[],frames:Array.from({length:12},(_,index)=>116+16*index),inputs:[{type:'click',trusted:true,startTime:101,receivedAt:102,nextFrameAt:132}],eventTiming:[],longTasks:[],layoutShifts:[],overflow:false,hidden:false,pendingInputFrames:0,previousBoundaryTasks:0});
}
export function smoothnessFixture(profile,engine){
 const input=profile!=='desktop-webgl'?'touch':'mouse',mobile=input==='touch',start={x:160,y:280},delta={dx:64,dy:12},end={x:224,y:292};
 const types=mobile?['touchStart',...Array(12).fill('touchMove'),'touchEnd']:['mouseMoved','mousePressed',...Array(12).fill('mouseMoved'),'mouseReleased'];
 const commands=types.map((type,index)=>{
  const progress=Math.max(0,Math.min(1,(index-(mobile?0:1))/12)),sentOffsetMs=index*30+(index===types.length-1?200:0);
  return{type,method:mobile?'Input.dispatchTouchEvent':'Input.dispatchMouseEvent',status:'fulfilled',x:start.x+delta.dx*progress,y:start.y+delta.dy*progress,sentOffsetMs,ackOffsetMs:sentOffsetMs+1};
 });
 const pan={input,start,end,delta,holdBeforeReleaseMs:200,commands,durationMs:commands.at(-1).ackOffsetMs,events:[{type:'pointerdown',time:100,trusted:true,pointerType:input,pointerId:1,...start},{type:'pointerup',time:800,trusted:true,pointerType:input,pointerId:1,...end}]};
 return{schemaVersion:1,profile,engine,input,physicalDevice:false,cpuSlowdownRate:1,cpuThrottleRestored:true,instrumented:false,traces:[],passed:true,pan,scenarios:SMOOTHNESS_SCENARIOS.map(smoothnessWindowFixture),performanceIssues:[],performancePassed:true};
}
