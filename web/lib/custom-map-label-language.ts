import type {MapTileLabel} from './custom-map-painter';
import type {MapSymbol} from './custom-map-symbols';

// Display-only vocabulary: source names, classifications and geometry stay
// unchanged. Match the whole name in its source context; never translate words
// inside a geographic proper name or guess a Russian spelling for that name.
const pathTerms:ReadonlyMap<string,string>=new Map([
  ['off road','Бездорожье'],['offroad','Бездорожье'],
  ['path','Тропа'],['trail','Тропа'],
  ['hiking trail','Пешеходная тропа'],['hiking path','Пешеходная тропа'],
  ['walking trail','Пешеходная тропа'],['walking path','Пешеходная дорожка'],
  ['footpath','Пешеходная тропа'],['foot path','Пешеходная тропа'],
  ['footway','Пешеходная дорожка'],['foot way','Пешеходная дорожка'],
  ['walkway','Пешеходная дорожка'],['pedestrian path','Пешеходная дорожка'],
  ['track','Проезд'],['forest track','Лесной проезд'],
  ['road','Дорога'],['forest road','Лесная дорога'],['service road','Служебная дорога'],
  ['dirt track','Грунтовая дорога'],['dirt road','Грунтовая дорога'],
  ['unpaved road','Дорога без твёрдого покрытия'],
  ['gravel track','Гравийный проезд'],['gravel road','Гравийная дорога'],
  ['cycleway','Велодорожка'],['cycle path','Велодорожка'],
  ['bicycle path','Велодорожка'],['bike path','Велодорожка'],
  ['bridleway','Конная тропа'],['horse trail','Конная тропа'],
  ['steps','Ступени'],['stairs','Лестница'],['boardwalk','Дощатая дорожка'],
  ['paved','Твёрдое покрытие'],['unpaved','Без твёрдого покрытия'],
  ['asphalt','Асфальт'],['concrete','Бетон'],['concrete plates','Бетонные плиты'],
  ['concrete:plates','Бетонные плиты'],['concrete:lanes','Бетонные колеи'],
  ['paving stones','Брусчатка'],['sett','Брусчатка'],['setts','Брусчатка'],
  ['cobblestone','Булыжник'],['cobblestones','Булыжник'],
  ['cobblestone:flattened','Плоский булыжник'],['unhewn cobblestone','Необработанный булыжник'],
  ['gravel','Гравий'],['fine gravel','Мелкий гравий'],['pebblestone','Галька'],
  ['compacted','Уплотнённое покрытие'],['ground','Грунт'],['dirt','Грунт'],['earth','Грунт'],
  ['sand','Песок'],['mud','Грязь'],['clay','Глина'],['salt','Соль'],
  ['grass','Трава'],['grass paver','Газонная решётка'],
  ['wood','Деревянный настил'],['woodchips','Щепа'],
  ['rock','Камни'],['stone','Камень'],['stepping stones','Камни для перехода'],
  ['snow','Снег'],['ice','Лёд'],['metal','Металл'],['plastic','Пластик'],
  ['rubber','Резиновое покрытие'],['artificial turf','Искусственный газон'],
]);
const waterTerms:ReadonlyMap<string,string>=new Map([
  ['water','Вода'],['lake','Озеро'],['river','Река'],['stream','Ручей'],['brook','Ручей'],
  ['pond','Пруд'],['reservoir','Водохранилище'],['canal','Канал'],['ditch','Канава'],
  ['sea','Море'],['ocean','Океан'],['bay','Залив'],['gulf','Залив'],['strait','Пролив'],
  ['waterfall','Водопад'],['waterfalls','Водопады'],
]);
const peakTerms:ReadonlyMap<string,string>=new Map([
  ['peak','Вершина'],['summit','Вершина'],['mountain peak','Горная вершина'],
  ['mountain','Гора'],['hill','Холм'],['ridge','Хребет'],['cliff','Обрыв'],
]);
const passTerms:ReadonlyMap<string,string>=new Map([
  ['pass','Перевал'],['mountain pass','Перевал'],['saddle','Седловина'],
]);
const symbolTerms:ReadonlyMap<MapSymbol,ReadonlyMap<string,string>>=new Map<MapSymbol,ReadonlyMap<string,string>>([
  ['peak',peakTerms],['pass',passTerms],
  ['camp',new Map([
    ['camp','Лагерь'],['campsite','Место для палаток'],['camp site','Место для палаток'],
    ['camping','Кемпинг'],['camping site','Кемпинг'],['campground','Кемпинг'],['camp ground','Кемпинг'],
    ['caravan site','Стоянка для автодомов'],['caravan park','Стоянка для автодомов'],
  ])],
  ['water',new Map([
    ['water','Вода'],['spring','Родник'],['natural spring','Родник'],
    ['drinking water','Питьевая вода'],['water point','Источник воды'],['water source','Источник воды'],
    ['water tap','Водопроводный кран'],['well','Колодец'],['fountain','Фонтан'],
    ['drinking fountain','Питьевой фонтанчик'],
  ])],
  ['shelter',new Map([
    ['shelter','Укрытие'],['hut','Хижина'],['alpine hut','Горный приют'],['mountain hut','Горный приют'],
    ['wilderness hut','Туристский приют'],['gazebo','Беседка'],['picnic shelter','Навес для отдыха'],
    ['lean to','Навес'],['bivouac','Бивак'],['bivouac site','Место для бивака'],
  ])],
  ['viewpoint',new Map([
    ['viewpoint','Смотровая площадка'],['view point','Смотровая площадка'],
    ['scenic viewpoint','Смотровая площадка'],['lookout','Смотровая площадка'],
    ['observation point','Смотровая точка'],['panorama','Панорама'],
  ])],
  ['waterfall',new Map([
    ['waterfall','Водопад'],['waterfalls','Водопады'],['cascade','Каскад'],
  ])],
  ['landmark',new Map([
    ['landmark','Достопримечательность'],['castle','Замок'],['ruins','Руины'],
    ['monument','Монумент'],['memorial','Мемориал'],['historic site','Историческое место'],
    ['archaeological site','Археологический памятник'],['archeological site','Археологический памятник'],
  ])],
  ['info',new Map([
    ['information','Информация'],['information board','Информационный стенд'],
    ['information point','Информационный пункт'],['information map','Информационная карта'],
    ['visitor centre','Информационный центр'],['visitor center','Информационный центр'],
    ['guidepost','Указатель'],['signpost','Указатель'],['map','Карта'],['route marker','Маршрутный указатель'],
  ])],
]);

export function mapLabelDisplayText(label:Pick<MapTileLabel,'text'|'kind'|'symbol'>):string{
  const vocabulary=label.kind==='path'?pathTerms:label.kind==='water'?waterTerms:
    label.kind==='peak'?(label.symbol==='pass'?passTerms:peakTerms):
    label.kind==='poi'&&label.symbol?symbolTerms.get(label.symbol):undefined;
  if(!vocabulary||!/[a-z]/i.test(label.text))return label.text;
  const key=label.text.trim().toLowerCase().replace(/[\u2010-\u2015\u2212_-]+/g,' ').replace(/\s+/g,' ');
  return vocabulary.get(key)??label.text;
}
