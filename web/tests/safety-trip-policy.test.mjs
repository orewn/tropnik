import test from 'node:test';
import assert from 'node:assert/strict';
import {startAllowed} from '../lib/trip-policy.ts';

test('required safety cannot be bypassed by a visible start button or an absent registered member',()=>{
 const departure={status:'ready',guideId:'guide',guideEligible:true,routeOpen:true,startsAt:'2026-11-10T10:00:00Z',endsAt:'2026-11-10T16:00:00Z',minPeople:4,mchsNotificationPolicy:'required',safetyStatus:'confirmed',mchsConfirmed:true,startContactConfirmed:true};
 const roster=['guide','a','b','c'].map(userId=>({userId,status:'checked_in'}));
 const now=Date.parse('2026-11-10T11:00:00Z');
 assert.equal(startAllowed(departure,roster,'guide',now),true);
 for(const patch of [{safetyStatus:'amendment_required'},{mchsConfirmed:false},{startContactConfirmed:false}])assert.equal(startAllowed({...departure,...patch},roster,'guide',now),false);
 assert.equal(startAllowed(departure,[...roster,{userId:'absent',status:'confirmed'}],'guide',now),false);
 assert.equal(startAllowed(departure,[...roster,{userId:'absent',status:'no_show'}],'guide',now),true);
});
