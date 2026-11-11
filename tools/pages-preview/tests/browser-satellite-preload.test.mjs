import test from 'node:test';
import assert from 'node:assert/strict';
import {holdSatelliteImagery} from '../browser-satellite-preload.mjs';
import {satelliteResource} from '../browser-satellite-audit.mjs';

const url='https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/4/3/0.jpg';
function transport(fail) {
 const listeners=new Map(),calls=[];
 return{calls,listeners,emit:event=>listeners.get('Fetch.requestPaused')?.(event),
  observe(name,callback){listeners.set(name,callback);return()=>listeners.delete(name);},
  async call(method,params={}){calls.push({method,params});if(fail?.(method,params))throw new Error('Transport failed');return{};},
 };
}

test('preload capture holds real imagery while leaving unrelated traffic and all response bytes untouched',async()=>{
 const cdp=transport(),gate=await holdSatelliteImagery(cdp,{match:satelliteResource});
 cdp.emit({requestId:'image',networkId:'network-image',request:{url}});
 cdp.emit({requestId:'ordinary',request:{url:'https://tiles.openfreemap.org/ordinary'}});
 const pending=gate.snapshot();assert.equal(pending.pending,1);assert.equal(pending.records[0].networkId,'network-image');assert.equal(pending.records[0].resumedAt,null);
 assert.ok(cdp.calls.some(call=>call.method==='Fetch.continueRequest'&&call.params.requestId==='ordinary'));
 assert.ok(!cdp.calls.some(call=>call.method==='Fetch.continueRequest'&&call.params.requestId==='image'));
 const complete=await gate.release('capture');assert.equal(complete.reason,'capture');assert.equal(complete.pending,0);assert.equal(complete.closed,true);assert.deepEqual(complete.errors,[]);assert.ok(complete.records[0].resumedAt>=complete.records[0].pausedAt);
 assert.equal(pending.records[0].resumedAt,null,'Later release must not rewrite captured pending proof');
 assert.equal(cdp.listeners.size,0);assert.equal(cdp.calls.filter(call=>call.method==='Fetch.disable').length,1);
 assert.deepEqual(cdp.calls.filter(call=>call.method==='Fetch.continueRequest').map(call=>Object.keys(call.params)),[['requestId'],['requestId']]);
 await gate.release('again');assert.equal(cdp.calls.filter(call=>call.method==='Fetch.disable').length,1);
 assert.ok(cdp.calls.every(call=>!['Fetch.fulfillRequest','Fetch.failRequest'].includes(call.method)));
});

test('request overflow and a failed resume still release every held request and remove interception',async()=>{
 const cdp=transport((method,params)=>method==='Fetch.continueRequest'&&params.requestId==='first');
 const gate=await holdSatelliteImagery(cdp,{match:satelliteResource,limit:1});
 cdp.emit({requestId:'first',request:{url}});cdp.emit({requestId:'overflow',request:{url}});
 const result=await gate.release('capture');assert.equal(result.reason,'overflow');assert.equal(result.records.length,1);assert.equal(result.observed,2);assert.equal(result.pending,0);
 assert.ok(result.errors.some(text=>text.includes('bounded')));assert.ok(result.errors.some(text=>text.includes('Transport failed')));
 assert.deepEqual(cdp.calls.filter(call=>call.method==='Fetch.continueRequest').map(call=>call.params.requestId).sort(),['first','overflow']);assert.equal(cdp.listeners.size,0);
 assert.equal(cdp.calls.at(-1).method,'Fetch.disable');
});

test('a missing capture cannot leave the renderer waiting after the bounded deadline',async()=>{
 const cdp=transport(),gate=await holdSatelliteImagery(cdp,{match:satelliteResource,timeoutMs:20});
 cdp.emit({requestId:'image',request:{url}});
 await new Promise(resolve=>setTimeout(resolve,35));
 const result=await gate.release('finally');assert.equal(result.reason,'timeout');assert.equal(result.pending,0);assert.ok(result.errors.some(text=>text.includes('deadline')));assert.equal(cdp.listeners.size,0);
});
