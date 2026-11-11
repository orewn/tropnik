import test from 'node:test';
import assert from 'node:assert/strict';
import {satelliteSourceForBounds,SATELLITE_PROVIDERS,SATELLITE_TILES,SATELLITE_MAX_ZOOM,SATELLITE_OVERVIEW_TILES,SATELLITE_OVERVIEW_MAX_ZOOM} from '../lib/map-satellite.ts';
import {isPriorityCity,priorityCityFontSize,priorityCityNames} from '../public/maps/map-city-labels.js';

test('custom satellite sources retain the licensed vintage and independent overview limit',()=>{
  assert.equal(SATELLITE_MAX_ZOOM,14);
  assert.equal(SATELLITE_OVERVIEW_MAX_ZOOM,8);
  assert.equal(SATELLITE_PROVIDERS['eox-s2'].tiles,SATELLITE_TILES);
  assert.equal(SATELLITE_PROVIDERS['eox-bluemarble'].tiles,SATELLITE_OVERVIEW_TILES);
  assert.match(SATELLITE_TILES,/\/s2cloudless_3857\/default\/g\/\{z\}\/\{y\}\/\{x\}\.jpg$/);
  assert.doesNotMatch(SATELLITE_TILES,/s2cloudless-20(?:1[89]|2\d)/);
  assert.match(SATELLITE_OVERVIEW_TILES,/\/bluemarble_3857\/default\/g\//);
  assert.match(SATELLITE_PROVIDERS['eox-s2'].attribution,/CC BY 4\.0/);
});

test('known source gaps select real overview imagery across either dateline representation',()=>{
  const source=(west,south,east,north)=>satelliteSourceForBounds({west,south,east,north});
  for(const bounds of [[157.73,61.8,190.96,71.61],[178.5,66,180.5,68],[178.5,70.8,181.2,71.7],[-181.5,66,-179.5,68],[179,66,-179,68],[-180,41,180,82],[19,41,191,82],[539,66,541,68]]){
    assert.equal(source(...bounds),'eox-bluemarble',JSON.stringify(bounds));
  }
  for(const bounds of [[30,66,36,71],[169,64,175.9,68],[183.1,65,190,70],[178,55,181,60.9],[178,72.6,181,74],[NaN,66,181,68]]){
    assert.equal(source(...bounds),'eox-s2',JSON.stringify(bounds));
  }
});

test('priority city labels preserve source class, actual names and bounded zoom sizes',()=>{
  assert.deepEqual([3,6,10,18].map(priorityCityFontSize),[13,17,20,20]);
  for(const name of priorityCityNames)assert.equal(isPriorityCity({class:'city','name:ru':name}),true);
  assert.equal(isPriorityCity({class:'village','name:ru':'Москва'}),false);
  assert.equal(isPriorityCity({class:'city',name:'Invented place'}),false);
  assert.equal(isPriorityCity({class:'city','name:ru':'Москва',name:'Moscow'}),true);
});
