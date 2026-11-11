/** Read-only hit testing of independently projected route points. A route's
 * own 44px button is the intended target, including its transparent hit area;
 * another route, a control or a covering panel must still reject the point. */
export function inspectTrailTouchTargets(points,doc=document,win=window){
 const map=doc.querySelector('.atlas-canvas[data-map-engine]');if(!map)return[];
 const targets=[];
 for(const point of points){
  if(!Number.isFinite(point.x)||!Number.isFinite(point.y)||point.x<12||point.y<12||point.x>=win.innerWidth-12||point.y>=win.innerHeight-12)continue;
  const hit=doc.elementFromPoint(point.x,point.y);if(!hit||!map.contains(hit))continue;
  if(hit.tagName==='CANVAS'){targets.push({...point,hit:{kind:'canvas'}});continue;}
  if(map.dataset.mapEngine!=='tropnik-canvas')continue;
  const button=hit.closest?.('button.tropnik-point-marker--trail[data-trail-id]');
  if(!button||!map.contains(button)||button.hidden||button.disabled||button.dataset.trailId!==point.id||button.dataset.mapMarkerId!==point.id)continue;
  const r=button.getBoundingClientRect();
  if(!(r.width>0&&r.height>0&&point.x>=r.left&&point.x<r.right&&point.y>=r.top&&point.y<r.bottom))continue;
  targets.push({...point,hit:{kind:'trail-marker',trailId:button.dataset.trailId,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}});
 }
 return targets;
}
