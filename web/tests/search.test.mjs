import test from 'node:test';
import assert from 'node:assert/strict';
import {createSearchIndex, normalizeSearchText, durationHours} from '../lib/search.ts';
const docs = [
  {id:'lake',kind:'route',title:'Байкал — Большие Коты',description:'Переход вдоль озера.',regionName:'Байкал',href:'/routes/lake',distanceKm:12,duration:'5–8 ч',accessStatus:'closed'},
  {id:'long',kind:'route',title:'Байкальская тропа — Голоустное',description:'Мыс Скрипер и побережье.',regionName:'Байкал',href:'/routes/long',distanceKm:30,duration:'2 дня'},
  {id:'unknown',kind:'route',title:'Байкал — маршрут без длины',description:'Длина и время требуют уточнения.',regionName:'Байкал',href:'/routes/unknown',distanceKm:null,duration:null,missingGeometry:true},
  {id:'bzerpin',kind:'route',title:'Бзерпинский карниз',description:'Через Медвежьи ворота.',regionName:'Краснодарский край',href:'/routes/bzerpin',distanceKm:12,duration:'1–5 дней'},
  {id:'altai',kind:'region',title:'Алтай',description:'Горные озёра.',href:'/regions/altai'},
  {id:'multa',kind:'route',title:'Мультинские озёра',description:'Переход по Катунскому хребту.',regionName:'Алтай',href:'/routes/multa',distanceKm:7,duration:'3 ч'},
  {id:'offline',kind:'page',title:'Карты с собой',description:'Скачать карту и пользоваться без интернета.',keywords:'офлайн offline',href:'/offline'},
  {id:'story',kind:'story',title:'Лес у Байкала',description:'Сведения о природе.',regionName:'Байкал',href:'/?region=baikal'},
];
const search=createSearchIndex(docs);
test('Russian spelling, grammatical forms and full descriptions are searchable',()=>{
 assert.equal(normalizeSearchText('  ОзЁра—Алтая! '),'озера алтая');
 assert.equal(search('на Алтае').results[0].id,'altai');
 assert.equal(search('Медвежьи ворота').results[0].id,'bzerpin');
 assert.equal(search('мультинские озера').results[0].id,'multa');
});
test('transliteration and incorrect keyboard layout find the same route',()=>{
 assert.ok(search('Baikal').results.some(x=>x.id==='lake'));
 const keyboard=search(',fqrfk');
 assert.equal(keyboard.correctedQuery,'байкал');
 assert.ok(keyboard.results.some(x=>x.id==='lake'));
 assert.equal(search('Bzerpin').results[0].id,'bzerpin');
});
test('bounded typos and adjacent transpositions do not require exact spelling',()=>{
 assert.equal(search('Бзепринский').results[0].id,'bzerpin');
 assert.equal(search('Мултинские').results[0].id,'multa');
 assert.equal(search('коты совершеннонесуществующий').total,0);
});
test('distance queries preserve closed and incomplete cards without asserting a matching distance',()=>{
 const result=search('Байкал до 15 км');
 assert.deepEqual(result.appliedFilters,['До 15 км']);
 assert.deepEqual(result.results.map(x=>x.id),['lake','unknown']);
 assert.equal(result.results[0].accessStatus,'closed');
 assert.equal(result.results[1].unspecifiedParameters,true);
 assert.equal(result.unspecifiedCount,1);
 assert.deepEqual(search('Байкал до 15 км',{includeUnspecified:false}).results.map(x=>x.id),['lake']);
});
test('range and duration constraints use maximum stated duration and retain unknowns explicitly',()=>{
 assert.deepEqual(search('Байкал от 10 до 20 км на один день',{includeUnspecified:false}).results.map(x=>x.id),['lake']);
 assert.ok(!search('Бзерпин на один день',{includeUnspecified:false}).results.length);
 assert.ok(search('Байкал на выходные').results.some(x=>x.id==='long'));
 assert.equal(durationHours('30–60 мин'),1);
 assert.equal(durationHours('1–5 дней'),120);
 assert.equal(durationHours('7–10 ч'),10);
 assert.equal(durationHours(null),null);
});
test('every public content kind is reachable; filters and pagination never cap the engine',()=>{
 assert.deepEqual(new Set(search('').results.map(x=>x.kind)),new Set(['route','region','page','story']));
 assert.equal(search('офлайн').results[0].id,'offline');
 assert.equal(search('Байкал',{kind:'story'}).results[0].id,'story');
 const many=Array.from({length:70},(_,i)=>({id:String(i),kind:'route',title:`Озеро ${i}`,description:'Описание',href:`/routes/${i}`}));
 assert.equal(createSearchIndex(many)('озеро').total,70);
});
test('query length and fuzzy work are bounded; search is pure and never fetches',()=>{
 const frozen=Object.freeze(docs.map(x=>Object.freeze({...x})));
 const result=createSearchIndex(frozen)('x'.repeat(5000));
 assert.equal(result.query.length,160);
 assert.equal(result.total,0);
 assert.throws(()=>createSearchIndex([docs[0],docs[0]]),/Duplicate/);
});
