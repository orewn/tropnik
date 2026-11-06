import test from 'node:test';
import assert from 'node:assert/strict';
import {api, apiEnvelope, ApiError} from '../lib/api.ts';
import {joinAllowed, startAllowed, reviewAllowed, zonedISO, mergeMessages} from '../lib/trip-policy.ts';

const now = Date.parse('2026-11-06T09:00:00Z');
const departure = {id:'departure', routeId:'route', routeRevisionId:'revision', guideId:'guide', guideName:'Guide', startsAt:'2026-11-06T10:00:00Z', endsAt:'2026-11-06T16:00:00Z', timeZone:'Europe/Moscow', minPeople:4, capacity:4, participantCount:3, status:'recruiting', version:7, routeOpen:true, guideEligible:true, membership:'none', createdAt:'2026-11-01T00:00:00Z'};

test('join control rejects a full, guide-free, closed or late departure', () => {
  assert.equal(joinAllowed(departure, now), true);
  for (const change of [{participantCount:4}, {guideEligible:false}, {guideId:null}, {routeOpen:false}, {status:'awaiting_guide'}, {membership:'no_show'}]) assert.equal(joinAllowed({...departure,...change}, now), false);
  assert.equal(joinAllowed(departure, Date.parse(departure.startsAt)), false);
});

test('start needs actual attendance including the guide and the scheduled time', () => {
  const group = {...departure, status:'ready', participantCount:4};
  const roster = ['guide','a','b','c'].map(userId => ({userId, displayName:userId, role:userId==='guide'?'guide':'tourist', status:'checked_in'}));
  assert.equal(startAllowed(group, roster, 'guide', Date.parse(group.startsAt)), true);
  assert.equal(startAllowed(group, roster, 'guide', now), false);
  assert.equal(startAllowed(group, roster.filter(p=>p.userId!=='guide'), 'guide', Date.parse(group.startsAt)), false);
  assert.equal(startAllowed({...group, guideEligible:false}, roster, 'guide', Date.parse(group.startsAt)), false);
});

test('reviews exclude the guide, no-show and duplicate target', () => {
  const group = {...departure, status:'completed', membership:'completed'};
  assert.equal(reviewAllowed(group, {id:'tourist'}, [], 'route'), true);
  assert.equal(reviewAllowed(group, {id:'guide'}, [], 'guide'), false);
  assert.equal(reviewAllowed({...group,membership:'no_show'}, {id:'tourist'}, [], 'route'), false);
  assert.equal(reviewAllowed(group, {id:'tourist'}, [{userId:'tourist',target:'route'}], 'route'), false);
  assert.equal(reviewAllowed(group, {id:'tourist'}, [{userId:'tourist',target:'route'}], 'guide'), true);
});

test('regional times convert to UTC and invalid dates are rejected', () => {
  assert.equal(zonedISO('2026-11-06T12:30','Europe/Moscow'),'2026-11-06T09:30:00.000Z');
  assert.equal(zonedISO('2026-11-06T12:30','Asia/Kamchatka'),'2026-11-06T00:30:00.000Z');
  assert.throws(()=>zonedISO('2026-02-30T12:30','Europe/Moscow'));
  assert.throws(()=>zonedISO('2026-11-06T24:30','Europe/Moscow'));
});

test('polling does not drop an acknowledged send and moderation tombstones replace text', () => {
  const first={id:'a',createdAt:'2026-11-06T09:00:00Z',body:'first',visibility:'visible'};
  const sent={id:'b',createdAt:'2026-11-06T09:00:01Z',body:'sent',visibility:'visible'};
  assert.deepEqual(mergeMessages([first,sent],[first]),[first,sent]);
  assert.equal(mergeMessages([first],[{...first,body:'',visibility:'hidden'}])[0].body,'');
  assert.equal(mergeMessages([first],[first]).length,1);
});

test('API preserves custom Headers, cursor and same-origin credentials', async () => {
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async(url, init)=>{
      assert.equal(url,'/api/backend/departures/id/join');
      assert.equal(init.headers.get('Idempotency-Key'),'stable-action-id');
      assert.equal(init.credentials,'same-origin');
      return Response.json({data:[],meta:{mode:'production',nextCursor:'cursor'}});
    };
    const result=await apiEnvelope('departures/id/join',{method:'POST',headers:new Headers({'Idempotency-Key':'stable-action-id'}),body:'{}'});
    assert.equal(result.meta.nextCursor,'cursor');
  } finally {globalThis.fetch=original;}
});

test('API handles 204 and rejects missing data instead of claiming success', async () => {
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response(null,{status:204});
    assert.equal(await api('auth/logout',{method:'POST',body:'{}'}),undefined);
    globalThis.fetch=async()=>Response.json({ok:true});
    await assert.rejects(api('auth/login'),error=>error instanceof ApiError&&error.code==='invalid_response');
  } finally {globalThis.fetch=original;}
});

test('logout distinguishes a cleared local cookie from an uncertain network failure', async () => {
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>Response.json({error:{code:'upstream_unavailable',message:'Server revocation unknown'}},{status:502,headers:{'X-Tropa-Session-Cleared':'1'}});
    await assert.rejects(api('auth/logout'),error=>error instanceof ApiError&&error.localSessionCleared);
    globalThis.fetch=async()=>{throw new TypeError('Failed to fetch');};
    await assert.rejects(api('auth/logout'),error=>error instanceof ApiError&&error.status===0&&!error.localSessionCleared);
  } finally {globalThis.fetch=original;}
});
