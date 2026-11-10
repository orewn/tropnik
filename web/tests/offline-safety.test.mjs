import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseOfflineSafety, saveLocalSafetyPassports, saveOfflineEmergencyCard, LOCAL_SAFETY_KEY, EMERGENCY_CARD_KEY, MAX_SAFETY_STORAGE_LENGTH} from '../public/offline-safety.js';

const draft = {schemaVersion:1,id:'offline-fixture',status:'draft',updatedAt:'2026-11-10T10:00:00Z',routeTitle:'Тестовая тропа',leaderName:'Тестовый руководитель',leaderPhone:'+70000000000',returnDeadline:'2026-11-12T18:00',timeZone:'Europe/Moscow',participants:[]};
const card = {departureId:'test-departure',routeTitle:'Тестовый выход',startsAt:'2026-11-11T10:00:00Z',endsAt:'2026-11-11T16:00:00Z',timeZone:'Europe/Moscow',leaderName:'Тестовый гид',leaderPhone:'+71111111111',mchsStatus:'submitted_unverified',emergencyContactName:'Тестовый контакт',emergencyContactPhone:'+72222222222',controlPoints:[],emergencyExits:[],messageTemplate:'Тестовое сообщение'};

test('cold offline parsing accepts an incomplete saved draft and labels its local status truthfully',()=>{
 const [value]=parseOfflineSafety(JSON.stringify([draft]),null);
 assert.equal(value.title,draft.routeTitle);
 assert.equal(value.facts.find(([label])=>label==='Телефон руководителя')[1],draft.leaderPhone);
 assert.equal(value.facts.find(([label])=>label==='Часовой пояс')[1],'Europe/Moscow');
 assert.match(value.notice,/черновик.*Не регистрация в МЧС/u);
 assert.equal(parseOfflineSafety(JSON.stringify([{...draft,status:'confirmed',mchsReference:'user-entered'}]),null)[0].notice,value.notice);
});

test('local saves honor the exact viewer code-unit limit and preserve prior data on an oversized draft',()=>{
 const values=new Map();let writes=0;
 const storage={setItem:(key,value)=>{values.set(key,value);writes++;}};
 const empty={...draft,routeDescription:''};
 const atLimit={...empty,routeDescription:'Я'.repeat(MAX_SAFETY_STORAGE_LENGTH-JSON.stringify([empty]).length)};
 saveLocalSafetyPassports(storage,[atLimit]);
 const previous=values.get(LOCAL_SAFETY_KEY);
 assert.equal(previous.length,MAX_SAFETY_STORAGE_LENGTH);
 assert.ok(Buffer.byteLength(previous,'utf8')>MAX_SAFETY_STORAGE_LENGTH);
 assert.equal(parseOfflineSafety(previous,null)[0].title,draft.routeTitle);
 const oversized={...atLimit,routeDescription:atLimit.routeDescription+'Я'};
 assert.throws(()=>saveLocalSafetyPassports(storage,[oversized]),error=>error instanceof RangeError&&/Изменения не сохранены/u.test(error.message));
 assert.equal(values.get(LOCAL_SAFETY_KEY),previous);
 assert.equal(writes,1);
 assert.equal(oversized.routeDescription.length,atLimit.routeDescription.length+1);
});

test('malformed and oversized storage fail closed and caller-owned text stays inert data',()=>{
 for(const value of [null,'', 'null','{}','[null,0,"x"]','bad JSON',' '.repeat(512*1024+1)])assert.deepEqual(parseOfflineSafety(value,value),[]);
 const html='<img src=x onerror=alert(1)>';
 const [value]=parseOfflineSafety(JSON.stringify([{...draft,routeTitle:html,leaderPhone:{toString:'bad'}}]),null);
 assert.equal(value.title,html);
 assert.equal(value.facts.find(([name])=>name==='Телефон руководителя')[1],'');
 assert.equal(parseOfflineSafety(JSON.stringify([{...draft,status:'server-confirmed'}]),null).length,0);
});

test('server copies are explicit bounded snapshots and exclude unrecognized private fields',()=>{
 const values=new Map();const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
 saveOfflineEmergencyCard(storage,{...card,allParticipantPhones:['must-not-be-copied']},new Date('2026-11-10T11:00:00Z'));
 saveOfflineEmergencyCard(storage,{...card,routeTitle:'Новая сохранённая версия'},new Date('2026-11-10T12:00:00Z'));
 const raw=values.get(EMERGENCY_CARD_KEY);
 assert.doesNotMatch(raw,/must-not-be-copied|allParticipantPhones/);
 assert.equal(JSON.parse(raw).length,1);
 const [value]=parseOfflineSafety(null,raw);
 assert.equal(value.title,'Новая сохранённая версия');
 assert.match(value.notice,/на момент сохранения.*не проверено/u);
 assert.equal(value.savedAt,'2026-11-10T12:00:00.000Z');
 assert.throws(()=>saveOfflineEmergencyCard(storage,{...card,departureId:''}),/неполную/);
 assert.throws(()=>saveOfflineEmergencyCard({getItem:()=>null,setItem:()=>{throw new Error('quota');}},card),/quota/);
});

test('viewer has no private fetch/cache writes or HTML interpretation path',async()=>{
 const source=await readFile(new URL('../public/offline-safety.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/\bfetch\s*\(|\.innerHTML\s*=|insertAdjacentHTML|caches\.open|document\.write/);
 assert.match(source,/\.textContent\s*=/);
 const html=await readFile(new URL('../public/offline-safety.html',import.meta.url),'utf8');
 for(const id of ['safety-detail','safety-list','safety-status'])assert.ok(html.includes('id="'+id+'"'));
 assert.match(html,/href="tel:112"/);
});

test('saved emergency exits and control points retain their precise coordinates after cold parsing',()=>{
 const values=new Map();const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
 const checkpoint={name:'Развилка',description:'У моста',latitude:60.3668134,longitude:28.6135291};
 const exit={name:'Выход к дороге',latitude:0,longitude:-179.9999999};
 saveOfflineEmergencyCard(storage,{...card,controlPoints:[checkpoint],emergencyExits:[exit]});
 // Saving another card reparses existing records; neither path may lose locations.
 saveOfflineEmergencyCard(storage,{...card,departureId:'another-departure'});
 const raw=values.get(EMERGENCY_CARD_KEY),stored=JSON.parse(raw).find(item=>item.card.departureId===card.departureId);
 assert.deepEqual(stored.card.controlPoints,[checkpoint]);
 assert.deepEqual(stored.card.emergencyExits,[{...exit,description:''}]);
 const value=parseOfflineSafety(null,raw).find(item=>item.recordId===card.departureId);
 assert.equal(value.facts.find(([name])=>name==='Контрольные точки')[1],'Развилка: У моста: Широта: 60.3668134; долгота: 28.6135291');
 assert.equal(value.facts.find(([name])=>name==='Аварийные выходы')[1],'Выход к дороге: Широта: 0; долгота: -179.9999999');
});

test('offline coordinates are paired finite numbers within geographic ranges',()=>{
 const values=new Map();const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
 for(const location of [{latitude:'60',longitude:28},{latitude:60},{latitude:null,longitude:28},{latitude:91,longitude:28},{latitude:60,longitude:181},{latitude:Infinity,longitude:28}]){
  saveOfflineEmergencyCard(storage,{...card,emergencyExits:[{name:'Без точной позиции',description:'Уточнить на месте',...location}]});
  const raw=values.get(EMERGENCY_CARD_KEY),[value]=parseOfflineSafety(null,raw);
  assert.deepEqual(JSON.parse(raw)[0].card.emergencyExits,[{name:'Без точной позиции',description:'Уточнить на месте'}]);
  assert.equal(value.facts.find(([name])=>name==='Аварийные выходы')[1],'Без точной позиции: Уточнить на месте');
 }
});
