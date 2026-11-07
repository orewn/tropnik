import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('safety UI never represents an unverified submission as confirmed registration',()=>{
 const panel=read('components/SafetyPanel.tsx');
 assert.match(panel,/submitted_unverified:'Отправлено, ждём проверки'/);
 assert.match(panel,/mchs\/confirmation/);
 assert.match(panel,/staff&&status==='submitted_unverified'/);
 assert.doesNotMatch(panel,/спасатели обязаны/iu);
 assert.match(panel,/не гарантирует конкретный результат операции/);
});

test('commercial payment concepts stay out of the safety release',()=>{
 const panel=read('components/SafetyPanel.tsx');
 const contract=read('lib/contract.ts');
 for(const forbidden of ['payment_intent','platformFeeBps','pricePerPersonMinor','payout','split-плат']){
  assert.equal(panel.includes(forbidden)||contract.includes(forbidden),false,forbidden);
 }
});

test('participants receive emergency card while private passport editing stays with guide or staff',()=>{
 const panel=read('components/SafetyPanel.tsx');
 const trips=read('components/Trips.tsx');
 assert.match(trips,/activeMember \|\| user\.staffRole !== 'none'/);
 assert.match(panel,/guide&&\['recruiting','ready','awaiting_guide'\]/);
 assert.match(panel,/href="tel:112"/);
 assert.match(panel,/navigator\.geolocation/);
 assert.match(panel,/Idempotency-Key/);
});
