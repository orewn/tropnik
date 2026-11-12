import {visibleMapBounds} from '../map-projection.mjs';
import {nativeClickFixture} from './experience-fixture.mjs';
import {terrainOpeningExpectedView} from '../browser-terrain-capture.mjs';

export function customMapFixture({camera={longitude:40.37,latitude:43.72,zoom:14},mode='detail',routeId='kavkaz-8a',imagerySource}={}){
 const bitmap=(kind,z=0,x=0,y=0)=>({key:`${kind}:${z}/${x}/${y}`,kind,z,x,y,local:kind==='overview',width:512,height:512,
  bounds:[x/2**z*360-180,Math.atan(Math.sinh(Math.PI*(1-2*(y+1)/2**z)))*180/Math.PI,(x+1)/2**z*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y/2**z)))*180/Math.PI],transparent:false});
 const imagery=imagerySource==='eox-bluemarble'?[bitmap(imagerySource,8,256,62),bitmap(imagerySource,8,255,62)]:imagerySource?[bitmap(imagerySource,4,14,3)]:[];
 const detail=mode!=='overview'&&camera.zoom>=5,relief=mode==='detail'&&detail;
 return{engine:'tropnik-canvas',readOnly:true,canvas:{connected:true,width:1000,height:700,cssWidth:1000,cssHeight:700},
  camera:{center:[camera.longitude,camera.latitude],zoom:camera.zoom},pitch:0,drawRevision:2,labelRevision:2,routeId,drawnRoute:routeId,
  state:{ready:true,loading:false,error:'',mode,committedMode:mode==='detail'&&!detail?'overview':mode,reliefReady:relief,imagerySource,imageryTarget:imagerySource,imageryLoading:false},
  coverage:{ready:true},tiles:{overview:[bitmap('overview')],detail:detail?[bitmap('vector')]:[],relief:relief?[bitmap('relief')]:[],imagery},labels:[],resources:{errors:[]}};
}

export function customSceneFixture(mobile,routeId='kavkaz-8a'){
 const width=mobile?412:1000,rect={left:0,top:72,right:width,bottom:772,width,height:700},camera={longitude:40.37,latitude:43.72,zoom:14,tileSize:256};
 const padding=mobile?{left:24,right:80,top:88,bottom:196}:{left:40,right:88,top:96,bottom:96},bounds=visibleMapBounds(camera,rect,padding);
 const bitmapInspection=customMapFixture({camera,routeId});bitmapInspection.canvas={connected:true,width,height:700,cssWidth:width,cssHeight:700};
 Object.assign(bitmapInspection,{viewport:{width,height:700,padding},visibleBounds:bounds});
 const beforeMap={engine:'tropnik-canvas',route:routeId,moving:false,visible:true,camera,rect,
  rendering:{painted:true,drawnRoute:routeId,coverageReady:true,tilesState:'ready'},bitmapInspection,
  viewportLayout:{width,height:772,panel:mobile?{left:0,right:width,top:600,bottom:772}:null}};
 const viewport={width,height:700,insets:mobile?{top:84,right:16,bottom:196,left:16}:{top:96,right:80,bottom:64,left:32}};
 const opening=terrainOpeningExpectedView(bounds,viewport);
 const expand=(extent,factor)=>{const x=(extent[0]+extent[2])/2,y=(extent[1]+extent[3])/2,w=(extent[2]-extent[0])*factor/2,h=(extent[3]-extent[1])*factor/2;return[x-w,y-h,x+w,y+h];};
 const requested=expand(bounds,2),native=expand(bounds,3);
 function state(frames,{distanceM=opening.distanceM,yaw=0,zoom=1.2,wide=false,revision=1}={}){
  const gridBounds=wide?expand(bounds,8):native,request=wide?gridBounds:requested,W=wide?513:660,H=wide?513:632;
  const middle=[(gridBounds[0]+gridBounds[2])/2,(gridBounds[1]+gridBounds[3])/2],metres=6371008.8*Math.PI/180;
  const w=(gridBounds[2]-gridBounds[0])*metres*Math.cos(middle[1]*Math.PI/180),h=(gridBounds[3]-gridBounds[1])*metres,scale=Math.max(w,h);
  const offset=[(opening.longitude-middle[0])/(gridBounds[2]-gridBounds[0])*w/scale,(opening.latitude-middle[1])/(gridBounds[3]-gridBounds[1])*h/scale];
  const view={yaw,pitch:.85,zoom,offset},geographicView={...opening,yaw,distanceM,zoom,bounds:gridBounds},spacing={eastWest:w/(W-1),northSouth:h/(H-1)};
  const provenance={provider:'Copernicus GLO-30',kind:wide?'remote-terrarium':'local-grid',requestedBounds:request,sourceNominalResolutionM:30,sourceUrls:[wide?'https://tiles.mapterhorn.com/12/2507/1493.webp':'/terrain-regions/south-sakhalin-v1/terrain-grid.json'],missingDataFilled:false,measurementAccuracyClaimedM:null,outputSpacingApproxM:spacing};
  const source={name:'Copernicus GLO-30',url:wide?'https://mapterhorn.com/data-access/':'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM',landscape:provenance};
  const surface={name:wide?'Copernicus Sentinel-2 / EOxCloudless':'ESA WorldCover 2021',kind:wide?'imagery':'landcover',bounds:gridBounds,projection:'regular-longitude-latitude',sampleLayout:'grid-nodes',rowOrder:'north-to-south',columnOrder:'west-to-east',loadedTiles:1,requestedTiles:1,localTiles:wide?0:1,complete:true,nativeResolutionM:10,acquisitionPeriod:wide?'2016–2017':'2021',attribution:wide?'EOX / Copernicus Sentinel-2':'ESA WorldCover 2021 / CC BY 4.0',...(wide?{provider:'eox-s2',tiles:[{url:'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2017_3857/default/g/12/1493/2507.jpg'}]}:{tiles:[]})};
  const width=wide?1024:1977,height=wide?1024:1894;
  return{schemaVersion:2,engine:'tropnik-terrain',navigation:'continuous-map',state:'ready',loadingWindow:false,windowRevision:revision,requestedWindowRevision:revision,frames,contextBounds:bounds,requestedBounds:request,loadedRequestBounds:request,view:geographicView,viewport,
   grid:{width:W,height:H,bounds:gridBounds,minElevation:100,maxElevation:200,sampleSpacingApproxM:spacing,source},provenance,
   displayMask:{state:'ready',width:2048,height:2048,source:{scope:'russia-display-area',coverageVersion:'a'.repeat(16),bounds:gridBounds,cells:['test-cell'],projection:'regular-longitude-latitude',sampleLayout:'pixel-cells',allowedPixels:4194304}},
   frame:{sourceVertices:W*H,meshStride:2,meshWindow:[0,0,W-1,H-1],renderedVertices:(Math.ceil((W-1)/2)+1)*(Math.ceil((H-1)/2)+1),triangles:Math.ceil((W-1)/2)*Math.ceil((H-1)/2)*2,renderer:'webgl2',view,geographicView,viewport,displayMask:{width:2048,height:2048,allowedPixels:4194304,coverageVersion:'a'.repeat(16)},cartography:{loadedTiles:1,requestedTiles:1,width,height}},
   cartography:{state:'ready',width,height,source:surface}};
 }
 const initial=state(2);
 const labels=[...Array(14).fill('Приблизить ландшафт'),...Array(14).fill('Отдалить ландшафт'),'Повернуть ландшафт','Вернуть исходный ракурс'];
 return{state:'ready',retainedMapNoticeVisible:false,zoomInputs:28,rotateInput:true,resetInput:true,imageChanged:true,visualReviewRequired:true,beforeMap,
  nativeInputs:labels.map(label=>({label,...nativeClickFixture(mobile?'touch':'mouse','scene-button',undefined,label)})),
  states:{initial,close:state(16,{zoom:32,distanceM:opening.distanceM/16}),wide:state(30,{zoom:.3,distanceM:opening.distanceM*2,wide:true,revision:2}),rotated:state(31,{zoom:.3,yaw:.25,distanceM:opening.distanceM*2,wide:true,revision:2}),reset:state(2)}};
}
