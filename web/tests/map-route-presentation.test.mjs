import test from 'node:test';
import assert from 'node:assert/strict';
import {routeLineEdges,routeStrokeWidth,territoryDetailOpacity,overviewContextCaption,overviewModeStatus,OVERVIEW_MESSAGE,routeEdgeDensity,syncRouteEdgeAnnotations} from '../lib/map-route-presentation.ts';


test('the observed short line shows letters at 53px and hides both annotations at 6px',()=>{
  const first=Object.freeze({x:100,y:100});
  assert.equal(routeEdgeDensity(first,Object.freeze({x:110,y:152})),'compact','the upper caption must not cover the lower badge');
  assert.equal(routeEdgeDensity(first,Object.freeze({x:101,y:106})),'hidden','neither edge can cover the other');
  assert.equal(routeEdgeDensity(first,Object.freeze({x:153,y:100})),'compact','horizontal captions also need more space than badges');
  assert.equal(routeEdgeDensity(first,Object.freeze({x:180,y:516})),'full','separated source edges keep their captions');
});

test('visible edge rectangles retain clearance on horizontal, vertical and diagonal pairs',()=>{
  // Actual CSS-pixel footprints, relative to each geographic anchor: a 32px
  // badge and a 64x24 caption placed 4px below it. Test the separate shapes,
  // including one caption against the other badge, not the classifier formula.
  const badge={left:-16,right:16,top:-16,bottom:16};
  const label={left:-32,right:32,top:20,bottom:44};
  const separated=(a,b)=>a.right+8<=b.left||b.right+8<=a.left||a.bottom+8<=b.top||b.bottom+8<=a.top;
  const translate=(rect,x,y)=>({left:rect.left+x,right:rect.right+x,top:rect.top+y,bottom:rect.bottom+y});
  for(let x=-120;x<=120;x+=4)for(let y=-120;y<=120;y+=4){
    const mode=routeEdgeDensity({x:0,y:0},{x,y});
    if(mode==='hidden')continue;
    const visible=mode==='full'?[badge,label]:[badge];
    for(const a of visible)for(const b of visible)assert.ok(separated(a,translate(b,x,y)),`${mode} must not overlap at ${x},${y}`);
    assert.equal(routeEdgeDensity({x,y},{x:0,y:0}),mode,'edge order must not affect visibility');
  }
  assert.equal(routeEdgeDensity({x:0,y:0},{x:39,y:39}),'hidden');
  assert.equal(routeEdgeDensity({x:0,y:0},{x:40,y:0}),'compact');
  assert.equal(routeEdgeDensity({x:0,y:0},{x:0,y:67}),'compact');
  assert.equal(routeEdgeDensity({x:0,y:0},{x:72,y:0}),'full');
  assert.equal(routeEdgeDensity({x:0,y:0},{x:0,y:68}),'full');
});

function trackedAnnotation(point){
  const writes=[],counts={projections:0};
  const dataset=new Proxy({}, {set(target,key,value){writes.push([key,value]);target[key]=value;return true;}});
  return{writes,counts,annotation:{element:{dataset},project:()=>{counts.projections++;return point;}}};
}

test('settled-camera sync updates only two stable annotations and only when density changes',()=>{
  const a={x:100,y:100},b={x:101,y:106},first=trackedAnnotation(a),last=trackedAnnotation(b);
  const annotations=[first.annotation,last.annotation];
  syncRouteEdgeAnnotations(annotations);
  syncRouteEdgeAnnotations(annotations);
  assert.deepEqual(first.writes,[['routeEdgeDensity','hidden']]);
  assert.deepEqual(last.writes,first.writes,'both crowded annotations hide together');
  assert.equal(first.counts.projections,2);assert.equal(last.counts.projections,2);
  b.x=110;b.y=152;syncRouteEdgeAnnotations(annotations);
  b.x=180;b.y=516;syncRouteEdgeAnnotations(annotations);
  assert.deepEqual(first.writes.map(([,value])=>value),['hidden','compact','full']);
  assert.deepEqual(last.writes,first.writes);
  assert.equal(annotations[0],first.annotation,'settled camera sync must not replace the adapters or marker nodes');
});

test('a single or truly shared source edge remains visible and invalid projections stay hidden',()=>{
  const closed={type:'LineString',coordinates:[[44,43],[44.1,43],[44,43]]};
  const before=structuredClone(closed),edges=routeLineEdges(closed);
  assert.equal(edges.length,1);assert.equal(edges[0].kind,'shared');
  const shared=trackedAnnotation({x:2,y:3});
  syncRouteEdgeAnnotations([shared.annotation]);
  assert.equal(shared.annotation.element.dataset.routeEdgeDensity,'full');
  assert.deepEqual(closed,before,'presentation never moves, joins or rewrites a source edge');
  assert.equal(routeEdgeDensity({x:0,y:0}),'full','a single covered edge is not a crowded pair');
  assert.equal(routeEdgeDensity(), 'hidden');
  assert.equal(routeEdgeDensity({x:NaN,y:0}),'hidden');
  assert.equal(routeEdgeDensity({x:0,y:0},{x:Infinity,y:1}),'hidden');
});

test('clearing and regenerating annotations cannot keep or revive the previous route adapters',()=>{
  const first=trackedAnnotation({x:0,y:0}),last=trackedAnnotation({x:1,y:6});
  const live=[first.annotation,last.annotation];
  syncRouteEdgeAnnotations(live);
  live.length=0;
  first.annotation.project=last.annotation.project=()=>{throw new Error('removed route projected');};
  syncRouteEdgeAnnotations(live);
  const replacement=trackedAnnotation({x:20,y:30});live.push(replacement.annotation);
  syncRouteEdgeAnnotations(live);
  assert.equal(replacement.annotation.element.dataset.routeEdgeDensity,'full');
  assert.equal(first.writes.length,1);assert.equal(last.writes.length,1);
});

test('overview limits stay visible at close zoom without leaking into detailed imagery or replacing real errors',()=>{
  for(const zoom of [6,11,14,18])assert.equal(overviewContextCaption('overview',zoom,false),'Обзор без деталей');
  for(const zoom of [0,5.99,NaN,Infinity])assert.equal(overviewContextCaption('overview',zoom,false),undefined);
  for(const mode of ['detail','satellite'])assert.equal(overviewContextCaption(mode,18,false),undefined);
  assert.equal(overviewContextCaption('overview',18,true),undefined,'a prepared 3D scene has its own detail');
  assert.equal(overviewModeStatus('','overview'),OVERVIEW_MESSAGE);
  assert.equal(overviewModeStatus(OVERVIEW_MESSAGE,'detail'),'');
  for(const error of ['Линия маршрута не загрузилась. Проверьте подключение.','Без сети: обзор.']){
    assert.equal(overviewModeStatus(error,'overview'),error);
    assert.equal(overviewModeStatus(error,'detail'),error);
  }
});

test('the two edges annotate an actual single line without changing any source vertices',()=>{
  const geometry={type:'LineString',coordinates:[[44,43,920],[44.01,43.02,1010],[44.1,43.04,1100]]};
  const original=structuredClone(geometry);
  const edges=routeLineEdges(geometry);
  assert.deepEqual(edges.map(edge=>[edge.kind,edge.coordinate]),[['first',[44,43]],['last',[44.1,43.04]]]);
  edges[0].coordinate[0]=99;
  assert.deepEqual(geometry,original,'marker edits cannot mutate the source route');
});

test('disconnected, reversed and merely adjacent source parts do not invent a whole-route start and finish',()=>{
  for(const parts of [
    [[[44,43],[44.1,43]],[[45,43],[45.1,43]]],
    [[[44.1,43],[44,43]],[[44.1,43],[44.2,43]]],
    [[[44,43],[44.1,43]],[[44.1,43],[44.2,43]]],
  ]) assert.deepEqual(routeLineEdges({type:'MultiLineString',coordinates:parts}),[]);
  const line=coordinates=>({type:'Feature',properties:{},geometry:{type:'LineString',coordinates}});
  assert.deepEqual(routeLineEdges({type:'FeatureCollection',features:[line([[44,43],[44.1,43]]),line([[45,43],[45.1,43]])]}),[]);
});

test('a shared edge is one mark, including equivalent antimeridian coordinates',()=>{
  const ring={type:'LineString',coordinates:[[44,43],[44.1,43],[44,43]]};
  assert.equal(routeLineEdges(ring).length,1);
  assert.equal(routeLineEdges(ring)[0].kind,'shared');
  assert.equal(routeLineEdges({type:'LineString',coordinates:[[180,65],[179.9,65],[-180,65]]})[0].kind,'shared');
  assert.deepEqual(routeLineEdges({type:'LineString',coordinates:[[44,43],[44,43],[44,43]]}),[]);
});

test('polygons and catalog points cannot become invented route edges',()=>{
  for(const geometry of [
    {type:'Point',coordinates:[44,43]},
    {type:'Polygon',coordinates:[[[44,43],[44.1,43],[44,43]]]},
    {type:'GeometryCollection',geometries:[]},
  ])assert.deepEqual(routeLineEdges(geometry),[]);
  const wrapped={type:'FeatureCollection',features:[
    {type:'Feature',properties:{},geometry:{type:'Point',coordinates:[0,0]}},
    {type:'Feature',properties:{},geometry:{type:'MultiLineString',coordinates:[[[44,43],[44.1,43]]]}},
  ]};
  assert.equal(routeLineEdges(wrapped).length,2);
});

test('detail widths and territorial prominence are bounded and continuous across the entire zoom range',()=>{
  let previousWidth=0,previousOpacity=1;
  for(let zoom=-2;zoom<=22;zoom+=.125){
    const width=routeStrokeWidth(zoom),opacity=territoryDetailOpacity(zoom);
    assert.ok(width>=3&&width<=5);
    assert.ok(opacity>=.219999&&opacity<=1);
    assert.ok(width>=previousWidth&&opacity<=previousOpacity);
    if(previousWidth)assert.ok(width-previousWidth<.05,'no sudden line-weight jump between zooms');
    previousWidth=width;previousOpacity=opacity;
  }
  assert.ok(Number.isFinite(routeStrokeWidth(NaN)));
  assert.ok(Number.isFinite(territoryDetailOpacity(NaN)));
});
