import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolveTrailCenter} from '../lib/map-coordinate.ts';

const covered=(lng,lat)=>lng>=19&&lng<=191&&lat>=41&&lat<=82;

test('keeps canonical longitude-latitude route centres',()=>{
  assert.deepEqual(resolveTrailCenter([40.608,43.747],covered,{center:[40,44],bounds:[36,42,42,47]}),[40.608,43.747]);
});

test('repairs imported latitude-longitude route centres',()=>{
  assert.deepEqual(resolveTrailCenter([43.747,40.608],covered,{center:[40,44],bounds:[36,42,42,47]}),[40.608,43.747]);
});

test('uses the selected territory when both orders lie inside Russia',()=>{
  assert.deepEqual(resolveTrailCenter([55,60],covered,{center:[60,55],bounds:[56,52,64,58]}),[60,55]);
});

test('rejects centres that cannot belong to the sourced Russia coverage',()=>{
  assert.equal(resolveTrailCenter([5,5],covered,{center:[60,55]}),undefined);
});

test('both map renderers prefer Russian, then local names, then Latin fallback',async()=>{
  const style=JSON.parse(await readFile(new URL('../public/maps/tropa-style.json',import.meta.url),'utf8'));
  const canvas=await readFile(new URL('../public/maps/canvas-style.js',import.meta.url),'utf8');
  const expressions=[];
  const walk=value=>{
    if(Array.isArray(value)){
      if(value[0]==='coalesce'&&value[1]?.[0]==='get'&&value[1]?.[1]==='name:ru')expressions.push(value);
      value.forEach(walk);
    }else if(value&&typeof value==='object')Object.values(value).forEach(walk);
  };
  walk(style);
  assert.ok(expressions.length>=5);
  for(const expression of expressions){
    const local=expression.findIndex(value=>Array.isArray(value)&&value[1]==='name');
    const latin=expression.findIndex(value=>Array.isArray(value)&&value[1]==='name:latin');
    if(latin>=0)assert.ok(local>0&&local<latin);
  }
  assert.match(canvas,/\['name:ru','name','name:latin'\]/);
});
