import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogueExpectations} from '../catalogue-expectations.mjs';
import {assertOverviewCounts, assertExploreExperience} from '../browser-report.mjs';
import {catalogueFixture, overviewCountsFixture, exploreExperienceFixture} from './experience-fixture.mjs';

test('source counts deduplicate multi-direction membership and retain territory-only routes in the total', () => {
  const source = catalogueExpectations([{id:'a',name:'А'},{id:'b',name:'Б'}], [
    {id:'one',regionId:'a',regionIds:['a','a','b']},
    {id:'two',regionId:'territory-ABC'},
  ]);
  assert.equal(source.total,2);
  assert.deepEqual(source.directions.map(({id,count})=>[id,count]),[['a',1],['b',1]]);
  assert.throws(()=>catalogueExpectations([{id:'a',name:'А'}],[{id:'same',regionId:'a'},{id:'same',regionId:'a'}]),/Duplicate/);
});

test('a stale rendered count cannot pass even when every visible control agrees with it', () => {
  const frame=overviewCountsFixture();
  assertOverviewCounts(frame,'same',catalogueFixture);
  const expected=catalogueExpectations([{id:'altai',name:'Алтай'},{id:'baikal',name:'Байкал'}],Array.from({length:22},(_,i)=>({id:`fixture-${i}`,regionId:i<12?'altai':'baikal'})));
  assert.notEqual(expected.sourceDigest,catalogueFixture.sourceDigest);
  assert.throws(()=>assertOverviewCounts(frame,'stale',expected),/source catalogue/);
});

test('the native exploration gate accepts the exact expanded source catalogue without a hardcoded Altai count', () => {
  const expected=catalogueExpectations([{id:'altai',name:'Алтай'},{id:'baikal',name:'Байкал'}],Array.from({length:22},(_,i)=>({id:`fixture-${i}`,regionId:i<12?'altai':'baikal'})));
  const receipt=exploreExperienceFixture(true),filter=receipt.filterReset;
  filter.baseline.count=filter.restored.count=12;
  for(const frame of [filter.overviewBefore,filter.overviewAfter]){
    frame.total=frame.mapTotal=22;
    frame.catalog.find(item=>item.id==='altai').count=12;
    const marker=frame.markers.find(item=>item.id==='altai');marker.count=12;marker.ariaLabel=marker.ariaLabel.replace('11','12');
  }
  for(const action of filter.reentryActions){
    action.grid.ariaLabel=action.grid.ariaLabel.replace('11','12');
    action.grid.surfaces.find(item=>item.kind==='count').text='12';
  }
  assertExploreExperience(receipt,'android-portrait','leaflet',true,expected);
  assert.throws(()=>assertExploreExperience(receipt,'android-portrait','leaflet',true,catalogueFixture),/source catalogue/);
});
