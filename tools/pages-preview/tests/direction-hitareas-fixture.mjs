import {directionHitGrid,directionExternalPoint} from '../browser-direction-hitareas.mjs';

export const hitRect=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});

export function directionGridFixture(regionId='altai',engine='leaflet'){
 const anchorRect=hitRect(100,100,44,44),available={left:0,top:0,right:500,bottom:500};
 const surfaces=[['label',hitRect(70,140,104,38),'Название'],['count',hitRect(130,108,24,20),'3']].map(([kind,rect,text])=>({
  kind,present:true,visible:true,text,rect,pointerEvents:'auto',
  samples:directionHitGrid(rect,anchorRect,kind==='count'?4:8).map(point=>({...point,withinViewport:true,owned:true,hitRegionId:regionId,hitHidden:false,hitTag:'SPAN'})),
 }));
 const hiddenRect=hitRect(200,200,44,44);
 return{schemaVersion:1,engine,regionId,anchorId:regionId,groupKey:regionId,cluster:false,ariaLabel:'Открыть направление',anchorRect,available,surfaces,
  hiddenControls:[{regionId:'inactive',hidden:true,display:'none',rect:hitRect(0,0,0,0),wrapper:engine==='leaflet'?{
   rect:hiddenRect,pointerEvents:'none',samples:directionHitGrid(hiddenRect,hiddenRect).map(point=>({...point,withinViewport:true,captures:false,hitTag:'CANVAS'})),
  }:null}]};
}

export function directionHitAreasFixture(engine='leaflet',mobile=true){
 const input=mobile?'touch':'mouse';
 return{schemaVersion:1,passed:true,engine,input,actions:[['label','altai'],['count','baikal']].map(([kind,id],index)=>{
  const grid=directionGridFixture(id,engine),point=directionExternalPoint(grid,kind);
  return{kind,input,grid,point,before:{region:'',route:'',zoom:2},after:{region:id,route:'',zoom:7},
   events:['pointerdown','pointerup','click'].map((type,event)=>({type,time:100+index*10+event,timestamp:100+index*10+(event?1:0),trusted:true,pointerType:input,pointerId:mobile?51:1,x:point.x,y:point.y,button:{regionId:id,groupKey:id}}))};
 })};
}
