import type {Route} from './contract';import type {Trail} from './content';
import {readRouteGeometry} from './route-geometry.ts';

/** The detail endpoint accepts an ID or a public slug. Selected cards already
 * have a canonical ID and additionally bind the exact reviewed revision. */
export function readPublishedRouteGeometry(payload: unknown, expectedId: string, expectedRevision?: string, allowSlug = false) {
 const route=payload as Partial<Route>|null;
 if(!route||typeof route!=='object'||typeof route.id!=='string'||!(/^[\w-]{1,128}$/).test(route.id)||
    (route.id!==expectedId&&!(allowSlug&&route.slug===expectedId))||typeof route.revisionId!=='string'||!(/^[\w-]{1,128}$/).test(route.revisionId)||
    expectedRevision!==undefined&&route.revisionId!==expectedRevision||route.geometryDetail!=='full'||route.geometry?.type!=='LineString')throw new Error('Published route revision changed or full geometry is unavailable');
 const geometry=readRouteGeometry(route.geometry);
 if(geometry.type!=='LineString'||geometry.coordinates.length<2)throw new Error('Full route geometry is unavailable');
 return geometry;
}
export function publishedTrail(r:Route):Trail{const c=r.geometry?.coordinates||[];const center=c.length?c[Math.floor(c.length/2)].slice(0,2) as [number,number]:undefined;const labels={easy:'Для начинающих',moderate:'Нужен опыт',hard:'Технически сложный',expert:'Высокие требования'};return{id:r.id,regionId:r.regionId,title:r.title,subtitle:'Опубликованный маршрут',description:r.description,distanceKm:r.distanceKm,duration:r.durationMin<120?`${r.durationMin} мин`:`${Math.round(r.durationMin/60*10)/10} ч`,ascentM:r.ascentM,difficulty:r.difficulty==='expert'?'hard':r.difficulty,difficultyLabel:labels[r.difficulty],...(r.geometryDetail==='full'?{geometry:r.geometry,geometryDetail:r.geometryDetail}:{}),geometryUrl:`/api/backend/routes/${encodeURIComponent(r.id)}`,sourceUrl:r.source.url,sourceName:r.source.name,checkedAt:(r.verifiedAt||r.source.retrievedAt).slice(0,10),publicationStatus:'published',season:r.season,revisionId:r.revisionId,sourceKind:'published',center,notes:['Проверить ограничения и погоду на конкретную дату.','Согласовать подготовку, снаряжение и темп с гидом.','Убедиться, что скачанная карта покрывает весь район выхода.'],...(r.status==='closed'?{accessStatus:'closed',operatingNotice:{title:'Маршрут закрыт',body:'Новые выходы и старт групп недоступны до изменения статуса оператором.',url:r.source.url,effectiveAt:r.updatedAt.slice(0,10)}}:{})};}
