import {unprojectMapPoint} from '../map-projection.mjs';
import {nativeClickFixture} from './experience-fixture.mjs';

export function customMapFixture({camera={longitude:40.37,latitude:43.72,zoom:14},mode='detail',routeId='kavkaz-8a',imagerySource}={}){
 const bitmap=(kind,z=0,x=0,y=0)=>({key:`${kind}:${z}/${x}/${y}`,kind,z,x,y,local:kind==='overview',width:512,height:512,
  bounds:[x/2**z*360-180,Math.atan(Math.sinh(Math.PI*(1-2*(y+1)/2**z)))*180/Math.PI,(x+1)/2**z*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y/2**z)))*180/Math.PI],transparent:false});
 const imagery=imagerySource==='eox-bluemarble'?[bitmap(imagerySource,8,256,62),bitmap(imagerySource,8,255,62)]:imagerySource?[bitmap(imagerySource,4,14,3)]:[];
 return{engine:'tropnik-canvas',readOnly:true,canvas:{connected:true,width:1000,height:700,cssWidth:1000,cssHeight:700},
  camera:{center:[camera.longitude,camera.latitude],zoom:camera.zoom},pitch:0,drawRevision:2,routeId,drawnRoute:routeId,
  state:{ready:true,loading:false,error:'',mode,committedMode:mode,reliefReady:true,imagerySource,imageryTarget:imagerySource,imageryLoading:false},
  coverage:{ready:true},tiles:{overview:[bitmap('overview')],detail:[bitmap('vector')],relief:[bitmap('relief')],imagery},labels:[],resources:{errors:[]}};
}

export function customSceneFixture(mobile,routeId='kavkaz-8a'){
 const rect={left:0,top:72,right:1000,bottom:772,width:1000,height:700},camera={longitude:40.37,latitude:43.72,zoom:14,tileSize:256};
 const beforeMap={engine:'tropnik-canvas',route:routeId,moving:false,visible:true,camera,rect,
  rendering:{painted:true,drawnRoute:routeId,coverageReady:true,tilesState:'ready'}};
 const nw=unprojectMapPoint({x:rect.left,y:rect.top},camera,rect),se=unprojectMapPoint({x:rect.right,y:rect.bottom},camera,rect),bounds=[nw[0],se[1],se[0],nw[1]];
 const view={yaw:-.48,pitch:.72,zoom:1,offset:[0,0]},source={name:'Observed source fixture',url:'test:source'};
 const initial={schemaVersion:1,engine:'tropnik-terrain',state:'ready',frames:2,requestedBounds:bounds,
  grid:{width:3,height:3,bounds,minElevation:100,maxElevation:200,source},provenance:{requestedBounds:bounds},
  frame:{sourceVertices:9,triangles:8,renderer:'webgl2',view,cartography:{loadedTiles:1,requestedTiles:1,width:1024,height:1024}},
  cartography:{state:'ready',width:1024,height:1024,source:{bounds,projection:'regular-longitude-latitude',sampleLayout:'grid-nodes',loadedTiles:1,requestedTiles:1}}};
 const state=(frames,patch)=>({...structuredClone(initial),frames,frame:{...structuredClone(initial.frame),view:{...structuredClone(view),...patch}}});
 const labels=[...Array(14).fill('Приблизить ландшафт'),...Array(14).fill('Отдалить ландшафт'),'Повернуть ландшафт','Вернуть исходный ракурс'];
 return{state:'ready',retainedMapNoticeVisible:false,zoomInputs:28,rotateInput:true,resetInput:true,imageChanged:true,visualReviewRequired:true,beforeMap,
  nativeInputs:labels.map(label=>({label,...nativeClickFixture(mobile?'touch':'mouse','scene-button',undefined,label)})),
  states:{initial,close:state(16,{zoom:5}),wide:state(30,{zoom:.65}),rotated:state(31,{zoom:.65,yaw:-.23}),reset:state(32,{})}};
}
