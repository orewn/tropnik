import test from 'node:test';
import assert from 'node:assert/strict';
import {mapTrailPointEntries,mapTrailPointFeatureCollection} from '../lib/map-trail-points.ts';

const covered=(lng,lat)=>lng>=19&&lng<=191&&lat>=41&&lat<=82;
const region={id:'south',name:'Юг',center:[40,44],bounds:[32,42,46,48]};
const trails=[
 {id:'direct',title:'Прямая',center:[40.6,43.7]},
 {id:'swapped',title:'Переставленная',center:[43.8,40.7]},
 {id:'outside',title:'Вне карты',center:[1,1]},
];

test('route point entries normalize coordinates once and keep selection metadata',()=>{
 const entries=mapTrailPointEntries(trails,covered,region,'swapped');
 assert.deepEqual(entries.map(item=>item.id),['direct','swapped']);
 assert.deepEqual(entries[0].center,[40.6,43.7]);
 assert.deepEqual(entries[1].center,[40.7,43.8]);
 assert.equal(entries[1].selected,true);
});

test('MapLibre point source is geographic and independent from DOM transforms',()=>{
 const data=mapTrailPointFeatureCollection(trails,covered,region,'direct',lng=>lng<0?lng+360:lng);
 assert.equal(data.features.length,2);
 assert.deepEqual(data.features[0].geometry.coordinates,[40.6,43.7]);
 assert.deepEqual(data.features[0].properties,{id:'direct',title:'Прямая',selected:true});
});
