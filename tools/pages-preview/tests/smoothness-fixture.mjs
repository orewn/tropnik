import {SMOOTHNESS_SCENARIOS,summarizeSmoothness} from '../browser-smoothness.mjs';

export function smoothnessWindowFixture(name='panel'){
 return summarizeSmoothness({schemaVersion:1,name,startedAt:100,endedAt:300,supported:{longtask:true,event:true,'layout-shift':true},errors:[],frames:Array.from({length:12},(_,index)=>116+16*index),inputs:[{type:'click',trusted:true,startTime:101,receivedAt:102,nextFrameAt:132}],eventTiming:[],longTasks:[],layoutShifts:[],overflow:false,hidden:false,pendingInputFrames:0,previousBoundaryTasks:0});
}
export function smoothnessFixture(profile,engine){
 return{schemaVersion:1,profile,engine,input:engine==='leaflet'?'touch':'mouse',physicalDevice:false,cpuSlowdownRate:1,cpuThrottleRestored:true,passed:true,scenarios:SMOOTHNESS_SCENARIOS.map(smoothnessWindowFixture),performanceIssues:[],performancePassed:true};
}
