import {COAST_FIXTURES} from '../browser-coast-audit.mjs';
import {unprojectMapPoint} from '../map-projection.mjs';

export function coastFixture(profile,engine){
 const mobile=engine==='leaflet',input=mobile?'touch':'mouse',start={x:160,y:280},delta={dx:24,dy:12},end={x:184,y:292};
 const types=mobile?['touchStart',...Array(12).fill('touchMove'),'touchEnd']:['mouseMoved','mousePressed',...Array(12).fill('mouseMoved'),'mouseReleased'];
 const commands=types.map((type,index)=>{
  const progress=Math.max(0,Math.min(1,(index-(mobile?0:1))/12)),sentOffsetMs=index===types.length-1?(index-1)*30+210:index*30;
  return{type,method:mobile?'Input.dispatchTouchEvent':'Input.dispatchMouseEvent',status:'fulfilled',x:start.x+delta.dx*progress,y:start.y+delta.dy*progress,sentOffsetMs,ackOffsetMs:sentOffsetMs+1};
 });
 const pan={input,start,end,delta,holdBeforeReleaseMs:200,commands,durationMs:commands.at(-1).ackOffsetMs,events:[{type:'pointerdown',time:100,trusted:true,pointerType:input,pointerId:1,...start},{type:'pointerup',time:800,trusted:true,pointerType:input,pointerId:1,...end}]};
 const rect={left:0,top:68,width:412,height:847},camera={longitude:28.6,latitude:60.36,zoom:9,tileSize:mobile?256:512};
 const center=unprojectMapPoint({x:rect.left+rect.width/2-delta.dx,y:rect.top+rect.height/2-delta.dy},camera,rect);
 pan.before={camera,rect};pan.after={camera:{...camera,longitude:center[0],latitude:center[1]},rect};
 const steps=COAST_FIXTURES.flatMap(fixture=>fixture.zooms.map(targetZoom=>({fixture:fixture.id,coordinate:[...fixture.coordinate],targetZoom,zoom:targetZoom,centerErrorPx:0,ready:true,pending:0,error:'',version:'c'.repeat(16),lod:targetZoom>=15?'source':targetZoom>=12?'local':'regional',cells:['coastal-cell']})));
 return{schemaVersion:1,profile,engine,passed:true,visualReviewRequired:true,steps,pans:[structuredClone(pan),structuredClone(pan)],screenshots:steps.map(({fixture,targetZoom})=>({fixture,targetZoom,file:`${profile}-coast-${fixture}-z${targetZoom}.png`,bytes:10000,sha256:'d'.repeat(64)})),resources:[{path:'/tropnik/data/map-coverage/manifest.json',status:200,finished:true},{path:'/tropnik/data/map-coverage/cells/coastal-cell-source.json',status:200,finished:true}]};
}
