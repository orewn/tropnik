import {trails,regions} from './content';
import {BRAND} from './brand';
import {placeFacts} from './facts';
import {createSearchIndex,type SearchDocument,type SearchOptions} from './search';
export type {SearchHit,SearchKind,SearchOptions,SearchResponse} from './search';
import {trailSearchDocument} from './route-search';
export {createRouteSearch} from './route-search';
const places=new Map(regions.map(region=>[region.id,region.name]));
const pages:SearchDocument[]=[
  {id:'map',kind:'page',title:'Карта маршрутов России',description:'Направления, тропы и места для походов на общей карте.',keywords:'карта россия регионы направления рельеф',href:'/'},
  {id:'routes',kind:'page',title:'Каталог пеших маршрутов России',description:'Тропы с подробными описаниями, источниками и известными параметрами пути.',keywords:'каталог маршруты тропы пешие походы описание',href:'/routes'},
  {id:'search',kind:'page',title:'Поиск по Тропинычу',description:'Найдите маршрут, направление, историю места или нужный раздел сервиса.',keywords:'поиск найти маршрут направление истории разделы фильтры',href:'/search'},
  {id:'planner',kind:'page',title:'Конструктор похода',description:'Соберите путь из участков соседних и пересекающихся троп. Выберите стыки и обязательные точки, распределите этапы по дням, сохраните план и GPX.',keywords:'составной комплексный поход конструктор планировщик маршрут соседние тропы пересечения общий участок стык переход этапы дни gpx джипиэкс',href:'/planner'},
  {id:'offline',kind:'page',title:'Карты с собой',description:'Скачать карты и сохранить маршруты для просмотра без интернета.',keywords:'офлайн скачать сохраненные избранное интернет связь карта',href:'/offline'},
  {id:'android',kind:'page',title:`${BRAND.name} для Android`,description:'Приложение и карта маршрутов на телефоне.',keywords:'андроид android приложение apk установить скачать телефон',href:'/android'},
  {id:'safety',kind:'page',title:'Подготовка к походу',description:'Снаряжение, условия посещения, сложность и план выхода.',keywords:'безопасность экипировка рюкзак аптечка список снаряжение памятка',href:'/safety'},
  {id:'safety-registration',kind:'page',title:'Паспорт безопасности и регистрация похода в МЧС',description:'Подготовьте маршрут, состав группы и аварийные контакты. Сохраните паспорт на устройстве и перенесите сведения в официальную форму МЧС.',keywords:'мчс паспорт безопасности регистрация уведомление туристической группы поход спасатели 112 аварийная карточка контакты руководитель план возвращения',href:'/safety/registration'},
  {id:'trips',kind:'page',title:'Походы и группы',description:'Обсуждение маршрутов и участие в походах с гидом.',keywords:'запрос набор участники попутчики группа заявка походы',href:'/trips'},
  {id:'community',kind:'page',title:'Сообщество',description:'Обсуждения, впечатления и отзывы о совместных походах.',keywords:'отзывы сообщения общение сообщество чат',href:'/community'},
  {id:'guides',kind:'page',title:'Гиды и инструкторы',description:'Подготовка и сопровождение группы на маршруте.',keywords:'гид инструктор проводник квалификация',href:'/guides'},
  {id:'account',kind:'page',title:'Личный кабинет',description:'Ваш профиль и история завершённых походов.',keywords:'профиль аккаунт пароль вход регистрация история почта',href:'/account'},
  {id:'about',kind:'page',title:'О Тропиныче',description:'Карта, подготовка к походу и люди, которым по пути.',keywords:`проект о нас ${BRAND.name} ${BRAND.previousName} ${BRAND.latinName}`,href:'/about'},
  {id:'sources',kind:'page',title:'Источники маршрутов',description:'Откуда взяты описания, карты и сведения о местности.',keywords:'источники лицензии данные авторские права',href:'/sources'},
  {id:'privacy',kind:'page',title:'Конфиденциальность',description:'Как хранятся сведения профиля, сохранённые маршруты и история походов.',keywords:'данные личные конфиденциальность удалить профиль',href:'/privacy'},
  {id:'terms',kind:'page',title:'Как пользоваться Тропинычем',description:'Правила сервиса, участие в походах и ответственность за подготовку.',keywords:'правила условия пользование ответственность',href:'/terms'},
];
export const searchDocuments:SearchDocument[]=[
  ...trails.map(trailSearchDocument),
  ...regions.map(region=>({id:region.id,kind:'region' as const,title:region.name,description:region.description,keywords:`${region.caption} ${region.terrain}`,href:`/regions/${region.id}`})),
  ...placeFacts.map(fact=>({id:fact.id,kind:'story' as const,title:fact.title,description:fact.body,regionName:places.get(fact.regionId),keywords:fact.place,href:`/?region=${encodeURIComponent(fact.regionId)}${fact.routeIds?.[0]?`&route=${encodeURIComponent(fact.routeIds[0])}`:''}`})),
  ...pages,
];
const index=createSearchIndex(searchDocuments);
export const searchSite=(query:string,options:SearchOptions={})=>index(query,options);
