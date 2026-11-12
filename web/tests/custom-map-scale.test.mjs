import test from 'node:test';
import assert from 'node:assert/strict';
import {mapDistanceScale} from '../lib/custom-map-scale.ts';

test('the ground ruler uses latitude and the current CSS zoom, not raster resolution',()=>{
  const equator=mapDistanceScale(0,14),north=mapDistanceScale(60,14);
  assert.equal(equator.metres,500);assert.equal(north.metres,200);
  assert.ok(Math.abs(north.pixels/north.metres-equator.pixels/equator.metres*2)<1e-10);
  const sakhalin=mapDistanceScale(46.94792542123872,14);
  assert.equal(sakhalin.label,'500 м');assert.ok(sakhalin.pixels>76&&sakhalin.pixels<77);
  for(const latitude of [0,47,70,85])for(const zoom of [0,2.75,8,10,14,18,22]){
    const scale=mapDistanceScale(latitude,zoom);
    assert.ok(scale.pixels>=38.4-1e-9&&scale.pixels<=96+1e-9);
    assert.ok(scale.metres>0);assert.ok(!/NaN|Infinity/.test(scale.label));
  }
});

test('invalid cameras cannot show a misleading distance',()=>{
  for(const [latitude,zoom,maxPixels] of [[NaN,14,96],[90,14,96],[47,-1,96],[47,Infinity,96],[47,14,0]])assert.equal(mapDistanceScale(latitude,zoom,maxPixels),null);
});
