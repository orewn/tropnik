import test from 'node:test';
import assert from 'node:assert/strict';
import {mapLabelDisplayText} from '../lib/custom-map-label-language.ts';

test('generic off-road source labels are Russian across case, spacing and dash variants',()=>{
  for(const text of ['off-road','off road','offroad','off_road','OFF-ROAD','  Off   Road  ','off\u2010road','off\u2011road','off\u2012road','off\u2013road','off\u2014road','off\u2015road','off\u2212road']){
    const label=Object.freeze({text,kind:'path'});
    assert.equal(mapLabelDisplayText(label),'Бездорожье',text);
    assert.equal(label.text,text,'Display normalization cannot replace the source name');
  }
});

test('generic paths, surfaces and outdoor names use the actual source context',()=>{
  const cases=[
    [{text:'track',kind:'path'},'Проезд'],
    [{text:'footway',kind:'path'},'Пешеходная дорожка'],
    [{text:'Hiking Trail',kind:'path'},'Пешеходная тропа'],
    [{text:'unpaved',kind:'path'},'Без твёрдого покрытия'],
    [{text:'fine_gravel',kind:'path'},'Мелкий гравий'],
    [{text:'concrete:plates',kind:'path'},'Бетонные плиты'],
    [{text:'lake',kind:'water'},'Озеро'],
    [{text:'Summit',kind:'peak',symbol:'peak'},'Вершина'],
    [{text:'mountain_pass',kind:'peak',symbol:'pass'},'Перевал'],
    [{text:'camp_site',kind:'poi',symbol:'camp'},'Место для палаток'],
    [{text:'caravan site',kind:'poi',symbol:'camp'},'Стоянка для автодомов'],
    [{text:'spring',kind:'poi',symbol:'water'},'Родник'],
    [{text:'drinking_water',kind:'poi',symbol:'water'},'Питьевая вода'],
    [{text:'wilderness_hut',kind:'poi',symbol:'shelter'},'Туристский приют'],
    [{text:'viewpoint',kind:'poi',symbol:'viewpoint'},'Смотровая площадка'],
    [{text:'waterfall',kind:'poi',symbol:'waterfall'},'Водопад'],
    [{text:'archaeological_site',kind:'poi',symbol:'landmark'},'Археологический памятник'],
    [{text:'guidepost',kind:'poi',symbol:'info'},'Указатель'],
  ];
  for(const [label,expected]of cases){
    const source={...label};Object.freeze(label);
    assert.equal(mapLabelDisplayText(label),expected);
    assert.deepEqual(label,source);
  }
});

test('proper names, Russian names, unnamed symbols and unrelated source contexts stay exact',()=>{
  const unchanged=[
    {text:'Off-road Panorama',kind:'path'},
    {text:'The Off Road',kind:'path'},
    {text:'«off-road»',kind:'path'},
    {text:'Camp David',kind:'poi',symbol:'camp'},
    {text:'Spring',kind:'place'},
    {text:'Spring',kind:'poi',symbol:'landmark'},
    {text:'off-road',kind:'place'},
    {text:'asphalt',kind:'water'},
    {text:'shelter',kind:'poi',symbol:'water'},
    {text:'Unknown Geographic Name',kind:'peak',symbol:'peak'},
    {text:'  Лесная тропа «Сосна»  ',kind:'path'},
    {text:'Тропа Off-road',kind:'path'},
    {text:'Озеро Светлое',kind:'water'},
    {text:'',kind:'poi',symbol:'water'},
    {text:'',kind:'peak',symbol:'peak'},
    {text:'400 м',kind:'contour'},
  ];
  for(const label of unchanged)assert.equal(mapLabelDisplayText(Object.freeze(label)),label.text);
});
