const MAX_LATITUDE=85.0511287798;
const worldY=latitude=>{
 const radians=Math.max(-MAX_LATITUDE,Math.min(MAX_LATITUDE,latitude))*Math.PI/180;
 return(1-Math.log(Math.tan(radians)+1/Math.cos(radians))/Math.PI)/2;
};
function validate(camera,rect){
 for(const value of [camera.longitude,camera.latitude,camera.zoom,camera.tileSize,rect.left,rect.top,rect.width,rect.height]){
  if(!Number.isFinite(value))throw new Error('Map camera or viewport is not finite');
 }
 if(![256,512].includes(camera.tileSize)||rect.width<=0||rect.height<=0)throw new Error('Map camera or viewport has invalid dimensions');
 if((camera.centerX!==undefined||camera.centerY!==undefined)&&![camera.centerX,camera.centerY].every(Number.isFinite))throw new Error('Map projection origin is not finite');
}

/** CSS coordinates from the settled public DOM camera; no map object access. */
export function projectMapPoint([longitude,latitude],camera,rect){
 validate(camera,rect);
 if(!Number.isFinite(longitude)||!Number.isFinite(latitude))throw new Error('Map point is not finite');
 const world=camera.tileSize*2**camera.zoom;
 const longitudeDelta=((longitude-camera.longitude+540)%360+360)%360-180;
 return{x:rect.left+(camera.centerX??rect.width/2)+longitudeDelta/360*world,y:rect.top+(camera.centerY??rect.height/2)+(worldY(latitude)-worldY(camera.latitude))*world};
}
export function unprojectMapPoint({x,y},camera,rect){
 validate(camera,rect);
 const world=camera.tileSize*2**camera.zoom;
 const longitude=camera.longitude+(x-rect.left-(camera.centerX??rect.width/2))/world*360;
 const mercator=worldY(camera.latitude)+(y-rect.top-(camera.centerY??rect.height/2))/world;
 return[longitude,Math.atan(Math.sinh(Math.PI*(1-2*mercator)))*180/Math.PI];
}

/** Independent inverse of the rendered CSS viewport. Retain continuous
 * longitude and all four corners for a rotated, pitched, partly covered map. */
export function visibleMapBounds(camera,rect,padding,pitch=0){
 validate(camera,rect);
 const bearing=camera.bearingDegrees??0;
 if(!Number.isFinite(bearing)||!Number.isFinite(pitch)||pitch<0||pitch>60||Math.abs(camera.latitude)>=90)throw new Error('Visible map angles are invalid');
 for(const key of ['left','right','top','bottom'])if(!Number.isFinite(padding?.[key])||padding[key]<0)throw new Error('Visible map padding is invalid');
 if(padding.left+padding.right>=rect.width||padding.top+padding.bottom>=rect.height)throw new Error('Visible map padding leaves no ground');
 const world=camera.tileSize*2**camera.zoom,angle=bearing*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle),pitchScale=Math.cos(pitch*Math.PI/180);
 const middleY=(1-Math.asinh(Math.tan(camera.latitude*Math.PI/180))/Math.PI)/2;
 const points=[];
 for(const x of [padding.left,rect.width-padding.right])for(const y of [padding.top,rect.height-padding.bottom]){
  const dx=x-rect.width/2,dy=(y-rect.height/2)/pitchScale;
  const longitude=camera.longitude+(cos*dx-sin*dy)/world*360,mercator=middleY+(sin*dx+cos*dy)/world;
  points.push([longitude,Math.atan(Math.sinh(Math.PI*(1-2*mercator)))*180/Math.PI]);
 }
 return[Math.min(...points.map(point=>point[0])),Math.min(...points.map(point=>point[1])),Math.max(...points.map(point=>point[0])),Math.max(...points.map(point=>point[1]))];
}

function inRing([x,y],ring){
 let inside=false;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const a=ring[i],b=ring[j];
  if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;
 }
 return inside;
}
export function pointInPolygonGeometry(point,geometry){
 const polygons=geometry?.type==='Polygon'?[geometry.coordinates]:geometry?.type==='MultiPolygon'?geometry.coordinates:[];
 return polygons.some(rings=>inRing(point,rings[0])&&!rings.slice(1).some(ring=>inRing(point,ring)));
}
