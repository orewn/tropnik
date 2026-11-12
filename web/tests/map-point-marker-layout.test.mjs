import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MAP_POINT_MARKER_SIZE,mapPointMarkerObstacle} from '../lib/map-point-marker-layout.ts';

const css=readFileSync(new URL('../app/custom-map.css',import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
const rules=new Map([...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([,selector,body])=>[selector.trim(),Object.fromEntries(body.split(';').filter(Boolean).map(declaration=>{const split=declaration.indexOf(':');return[declaration.slice(0,split).trim(),declaration.slice(split+1).trim()];}))]));
const px=value=>{assert.match(value,/^\d+(?:\.\d+)?px$/);return parseFloat(value);};
const point={x:213.25,y:142.75};

test('projected point footprints cover CSS circle and shadow declarations without reserving the transparent hit target',()=>{
 const button=rules.get('.tropnik-point-marker'),base=rules.get('.tropnik-point-marker::before');
 for(const property of ['width','height','min-width','min-height'])assert.equal(px(button[property]),MAP_POINT_MARKER_SIZE);
 // The combined active-position case reserves both the selected dimensions and
 // position halo, conservatively covering either state rule's shadow winning.
 for(const [kind,active,selectors]of [['trail',false,[]],['trail',true,['.tropnik-point-marker.is-selected::before']],['position',false,['.tropnik-point-marker--position::before']],['position',true,['.tropnik-point-marker.is-selected::before','.tropnik-point-marker--position::before']]]){
  const style=Object.assign({},base,...selectors.map(selector=>rules.get(selector))),border=parseFloat(style.border),shadow=Number(style['box-shadow'].match(/^0 0 0 (\d+)px /)?.[1]);
  assert.equal(Number.isFinite(border)&&Number.isFinite(shadow),true);
  const left=point.x-MAP_POINT_MARKER_SIZE/2+px(style.left)-shadow,top=point.y-MAP_POINT_MARKER_SIZE/2+px(style.top)-shadow;
  // ::before has its default content-box; include both borders and the spread.
  const right=left+px(style.width)+2*border+2*shadow,bottom=top+px(style.height)+2*border+2*shadow;
  const rect=mapPointMarkerObstacle(point,kind,active);
  assert.deepEqual(rect,{left:left-2,top:top-2,right:right+2,bottom:bottom+2},kind+' retains the painted shadow and a two-pixel guard');
  assert.ok(rect.right-rect.left<MAP_POINT_MARKER_SIZE,'Nearby text must not be rejected just because the invisible hit target is larger');
 }
});

test('planner boxes and keyboard focus keep their whole painted footprint at fractional anchors',()=>{
 const style=rules.get('.tropnik-point-marker--plan'),margin=px(style.margin),width=px(style.width),height=px(style.height);
 const left=point.x-MAP_POINT_MARKER_SIZE/2+margin,top=point.y-MAP_POINT_MARKER_SIZE/2+margin;
 assert.deepEqual(mapPointMarkerObstacle(point,'plan'),{left:left-2,top:top-2,right:left+width+2,bottom:top+height+2});
 for(const kind of ['trail','position','plan']){
  const focus=mapPointMarkerObstacle(point,kind,true,true);
  assert.equal(focus.left,point.x-MAP_POINT_MARKER_SIZE/2-2);assert.equal(focus.top,point.y-MAP_POINT_MARKER_SIZE/2-2);
  assert.equal(focus.right,point.x+MAP_POINT_MARKER_SIZE/2+2);assert.equal(focus.bottom,point.y+MAP_POINT_MARKER_SIZE/2+2);
 }
});
