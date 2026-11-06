import importedCatalog from './catalog.generated.json';
import importedPoints from './route-points.generated.json';
import displayCoverage from '@/public/data/russia-boundaries-provenance.json';
export type Region = {
  id: string; name: string; caption: string; description: string; terrain: string;
  center: [number, number]; zoom: number; shapeNames: string[]; tint: string; timezone: string;
};

export const regions: Region[] = [
  { id: 'altai', name: 'Алтай', caption: 'Горы. Озёра. Простор.', terrain: 'Горные тропы', tint: '#CDD8C6', center: [86.8, 50.5], zoom: 6.1, timezone: 'Asia/Barnaul', shapeNames: ['Altai Republic', 'Republic of Altai', 'Altai Krai'], description: 'Выберите район Алтая и изучите маршрут перед выходом. В каталоге отдельно отмечаем техническую сложность, нагрузку и дату проверки тропы. Туристическое направление включает территории, которые не совпадают с границей одного региона.' },
  { id: 'krasnodar', name: 'Краснодарский край', caption: 'От моря к вершинам.', terrain: 'Кавказ и предгорья', tint: '#D9DDC1', center: [40.05, 44.05], zoom: 7, timezone: 'Europe/Moscow', shapeNames: ['Krasnodar Krai'], description: 'Маршруты Черноморского побережья, предгорий и Западного Кавказа. Участки в заповедниках и национальных парках требуют отдельной проверки действующих правил посещения. Карточка тропы и разрешение на её посещение — разные вещи.' },
  { id: 'karelia', name: 'Карелия', caption: 'Лес, вода и тишина.', terrain: 'Лесные маршруты', tint: '#C8D7CF', center: [33.2, 63.3], zoom: 5.9, timezone: 'Europe/Moscow', shapeNames: ['Republic of Karelia', 'Karelia'], description: 'Планируйте поход по лесам и озёрным районам Карелии. Для каждой опубликованной тропы понадобятся сведения о покрытии, переправах, точках старта и сезонных ограничениях. Пока проверенных выходов нет, их набор не открывается.' },
  { id: 'krym', name: 'Крым', caption: 'Тропы над морем.', terrain: 'Горы и побережье', tint: '#E0D7BD', center: [34.2, 44.8], zoom: 8, timezone: 'Europe/Moscow', shapeNames: ['Republic of Crimea', 'Crimea'], description: 'Туристическое направление для выбора горных и прибрежных маршрутов. Перед выходом необходимо проверить доступность конкретного участка и действующие ограничения. Подробная карта и актуальное подтверждение маршрута публикуются отдельно.' },
  { id: 'baikal', name: 'Байкал', caption: 'Большое озеро. Большой путь.', terrain: 'Прибрежные тропы', tint: '#CCDCE0', center: [108.0, 53.3], zoom: 6, timezone: 'Asia/Irkutsk', shapeNames: ['Irkutsk Oblast', 'Republic of Buryatia', 'Buryatia'], description: 'Байкал объединяет маршруты разных административных территорий. Поэтому один маршрут имеет собственную страницу и может встречаться в нескольких региональных подборках. Сезон, разрешения и фактические условия проверяются для каждого выхода.' },
  { id: 'kamchatka', name: 'Камчатка', caption: 'Встреча с большим ландшафтом.', terrain: 'Вулканы и долины', tint: '#D9D2C7', center: [159.8, 54.5], zoom: 5.7, timezone: 'Asia/Kamchatka', shapeNames: ['Kamchatka Krai'], description: 'Направление для походов с подходящим по квалификации инструктором. В карточке важны удалённость, технические участки, сезон и необходимые разрешения. Наличие объекта на общей карте не означает готовность маршрута к прохождению.' },
];

export type Trail = {
  id: string; regionId: string; title: string; subtitle: string; description: string;
  distanceKm: number | null; duration: string | null; ascentM: number | null;
  difficulty: 'easy' | 'moderate' | 'hard' | 'unknown'; difficultyLabel: string;
  geometryUrl?: string; sourceUrl: string; sourceName: string; checkedAt: string;
  publicationStatus: 'reference' | 'published'; season: string; notes: string[];
  operatingNotice?: {title:string;body:string;url:string;effectiveAt:string};
  sourceKind?:'database'|'official'|'published'; officialEvidence?:{url:string;summary:string;checkedAt:string;scope:string}; center?:[number,number]; bbox?:number[];
  sourceTechnicalDifficulty?:string|null; geometryLengthKm?:number; osmId?:number; regionIds?:string[]; revisionId?:string; geometry?:unknown;
};

// Published source records are added only with a source, timestamp and explicit status.
// A reference card is not a verified hiking permit or a bookable departure.
const initialTrails: Trail[] = [
  {
    "id": "kavkaz-16a",
    "regionId": "krasnodar",
    "title": "Тисо-самшитовая роща — Малое кольцо",
    "subtitle": "Маршрут 16А · Сочи, Хоста",
    "description": "Кольцевая прогулка от визит-центра через каменный лабиринт, смотровую площадку «Белые скалы» и участок с тисом-великаном. Параметры приведены по официальному описанию. Геометрия OSM пока не сверена с полной официальной ниткой.",
    "distanceKm": 1.6,
    "duration": "30–60 мин",
    "ascentM": null,
    "difficulty": "unknown",
    "difficultyLabel": "Сложность требует проверки",
    "geometryUrl": "/data/routes/3748147.geojson",
    "sourceUrl": "https://www.kavkazzapoved.ru/routes/no16a-tiso-samshitovaya-roscha-maloe-kolco",
    "sourceName": "Кавказский заповедник",
    "checkedAt": "2026-11-06",
    "publicationStatus": "reference",
    "season": "Уточняется у заповедника",
    "notes": [
      "Перед выходом проверить действующие правила и разрешение на посещение заповедной территории.",
      "На карте показаны реальные сегменты OpenStreetMap. Их соответствие официальной нитке и полнота не проверены; это не готовый навигационный трек.",
      "Соответствие подготовки участников и квалификации гида условиям маршрута."
    ]
  },
  {
    "id": "kavkaz-16b",
    "regionId": "krasnodar",
    "title": "Тисо-самшитовая роща — Большое кольцо",
    "subtitle": "Маршрут 16Б · Сочи, Хоста",
    "description": "Большой круг по роще проходит через каменный лабиринт, Буковую поляну и каньон реки Хоста; на пути описаны ступени, подъёмы и спуски. Параметры приведены по официальному описанию. Геометрия OSM пока не сверена с полной официальной ниткой.",
    "distanceKm": 5,
    "duration": "3–6 ч",
    "ascentM": null,
    "difficulty": "unknown",
    "difficultyLabel": "Сложность требует проверки",
    "geometryUrl": "/data/routes/3748250.geojson",
    "sourceUrl": "https://www.kavkazzapoved.ru/routes/no16b-tiso-samshitovaya-roscha-bolshoe-kolco",
    "sourceName": "Кавказский заповедник",
    "checkedAt": "2026-11-06",
    "publicationStatus": "reference",
    "season": "Уточняется у заповедника",
    "notes": [
      "Перед выходом проверить действующие правила и разрешение на посещение заповедной территории.",
      "На карте показаны реальные сегменты OpenStreetMap. Их соответствие официальной нитке и полнота не проверены; это не готовый навигационный трек.",
      "Соответствие подготовки участников и квалификации гида условиям маршрута."
    ]
  },
  {
    "id": "kavkaz-8a",
    "operatingNotice":{"title":"По сообщению от 26.10.2026: доступ частичный","body":"С 27 октября 2026 года открыт только участок до Бзерпинского карниза. Лагерь Холодный закрыт. На карте остаётся полная геометрия источника; она не обозначает разрешённый участок.","url":"https://www.kavkazzapoved.ru/news/s-27-oktyabrya-zakryvaetsya-chast-letnikh-turisticheskikh-marshrutov","effectiveAt":"2026-10-27"},
    "regionId": "krasnodar",
    "title": "Медвежьи ворота — Бзерпинский карниз — лагерь Холодный",
    "subtitle": "Маршрут 8А · Красная Поляна, Кавказский заповедник",
    "description": "Горный маршрут от урочища Медвежьи ворота через Бзерпинский карниз и перевал Псеашха в направлении лагеря Холодный. Показатели относятся к официальной нитке целиком. Параметры приведены по официальному описанию. Геометрия OSM пока не сверена с полной официальной ниткой.",
    "distanceKm": 12,
    "duration": "1–5 дней",
    "ascentM": null,
    "difficulty": "unknown",
    "difficultyLabel": "Сложность требует проверки",
    "geometryUrl": "/data/routes/11566519.geojson",
    "sourceUrl": "https://www.kavkazzapoved.ru/routes/no-8a-urochische-medvezhi-vorota-bzerpinskiy-karniz-lager-kholodnyy",
    "sourceName": "Кавказский заповедник",
    "checkedAt": "2026-11-06",
    "publicationStatus": "reference",
    "season": "Уточняется у заповедника",
    "notes": [
      "Перед выходом проверить действующие правила и разрешение на посещение заповедной территории.",
      "На карте показаны реальные сегменты OpenStreetMap. Их соответствие официальной нитке и полнота не проверены; это не готовый навигационный трек.",
      "Соответствие подготовки участников и квалификации гида условиям маршрута."
    ]
  }
];

// Keep the source archive intact; the Russia catalogue excludes geometries wholly outside the sourced display area.
const outsideDisplayCoverage=new Set(displayCoverage.excludedCatalogRouteIds);
export const trails:Trail[] = [...initialTrails.map(t=>({...t,...(importedPoints as Record<string,unknown>)[t.id] as object})),...(importedCatalog as Trail[])].filter(trail=>!outsideDisplayCoverage.has(trail.id));

export const regionById = (id: string) => regions.find(r => r.id === id);
export const trailById = (id: string) => trails.find(r => r.id === id);
export const getRegionTrails = (id: string) => trails.filter(r => r.regionId === id||r.regionIds?.includes(id));
export const getOrigin = () => process.env.NEXT_PUBLIC_SITE_URL || 'https://tropa-rf-atlas-2026.wintrybluebell1.chatgpt.site';
export const isPublicIndexingEnabled = () => process.env.TROPA_PUBLIC_INDEXING === 'true';

export const gearChecklist = ['Карта и маршрут сохранены на устройстве', 'Заряженный телефон и запас питания', 'Одежда и обувь для условий маршрута', 'Вода и питание по плану гида', 'Личные необходимые средства и аптечка', 'Гид и фактический состав подтверждены', 'Ограничения и разрешения проверены', 'План выхода оставлен контактному лицу'];

export function routeCountLabel(count:number){const n=count%100;return `${count} ${n>10&&n<20?'маршрутов':count%10===1?'маршрут':count%10>=2&&count%10<=4?'маршрута':'маршрутов'}`;}
