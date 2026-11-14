import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {ArrowRight, ArrowSquareOut} from '@/components/TropnikIcons';
import {SourceDifficulty} from '@/components/SourceDifficulty';
import {RouteSources} from '@/components/RouteSources';
import {Header} from '@/components/Header';
import {Footer} from '@/components/Footer';
import {Explore} from '@/components/Explore';
import {SeoBreadcrumbs} from '@/components/SeoBreadcrumbs';
import {getPublishedTrail} from '@/lib/server';
import {regions, trails, trailById} from '@/lib/content';
import {mapRegionById} from '@/lib/territories';
import {formatEvidenceDate, sourceDateLabel, trailGeometryDescription} from '@/lib/trail-evidence';
import {canonicalUrl, isRouteSeoEligible, routeSeo, serializeJsonLd} from '@/lib/seo';
import {getSeoContext, seoMetadata} from '@/lib/seo-metadata';

export async function generateMetadata({params}: {params: Promise<{id: string}>}): Promise<Metadata> {
  const {id} = await params;
  const trail = await getPublishedTrail(id) || trailById(id);
  return trail ? seoMetadata(routeSeo(trail, regions, getSeoContext()))
    : {title: 'Маршрут не найден', robots: {index: false, follow: true}};
}

export default async function RoutePage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  const trail = await getPublishedTrail(id) || trailById(id);
  if (!trail) notFound();
  const context = getSeoContext();
  const seo = routeSeo(trail, regions, context);
  const candidates = trails.filter(item => item.id !== trail.id && isRouteSeoEligible(item));
  const localRelated = candidates.filter(item => item.regionId === trail.regionId
    || item.regionIds?.includes(trail.regionId) || trail.regionIds?.includes(item.regionId));
  const related = (localRelated.length ? localRelated : candidates).slice(0, 4);
  return <><Header/><main id="main">
    <Explore initialPublished={trail.publicationStatus === 'published' ? [trail] : []} initialRegion={trail.regionId} initialTrail={trail.id}/>
    <article className="region-article seo-article">
      <SeoBreadcrumbs breadcrumbs={seo.breadcrumbs}/>
      <span className="eyebrow">Паспорт маршрута · {mapRegionById(trail.regionId)?.name}</span>
      <h2 className="heading-4">{seo.heading}</h2>
      <p>{trail.description}</p>
      <dl className="facts-grid">
        <div><dt>Длина по источнику</dt><dd>{trail.distanceKm === null ? 'Не подтверждена' : `${trail.distanceKm.toLocaleString('ru')} км`}{trail.distanceNote && <p className="source-note">{trail.distanceNote}</p>}</dd></div>
        <div><dt>Время по источнику</dt><dd>{trail.duration || 'Не подтверждено'}</dd></div>
        <div><dt>Сложность</dt><dd>{trail.difficultyLabel}</dd></div>
        <div><dt>Набор высоты</dt><dd>{trail.ascentM === null ? 'Пока не подтверждён' : `${trail.ascentM} м`}</dd></div>
        <div><dt>Условия посещения</dt><dd>{trail.accessStatus === 'closed' ? 'Посещение закрыто' : trail.accessStatus === 'restricted' ? 'Есть ограничения' : 'Уточните перед выходом'}</dd></div>
        <div><dt>{sourceDateLabel(trail.sourceKind)}</dt><dd>{formatEvidenceDate(trail.checkedAt)}</dd></div>
      </dl>
      {trail.operatingNotice && <div className="notice-block warning">
        <strong>{trail.operatingNotice.title}</strong><p>{trail.operatingNotice.body}</p>
        <a href={trail.operatingNotice.url} target="_blank" rel="noopener noreferrer">Официальное сообщение <ArrowSquareOut size={18}/></a>
      </div>}
      <SourceDifficulty trail={trail}/>
      <h3>Линия пути и условия</h3>
      <p>{trailGeometryDescription(trail)} Карточка не подтверждает открытие территории на выбранную дату. {trail.publicationStatus === 'reference'
        ? 'Походы здесь пока не опубликованы.'
        : 'Даты выходов и фактический состав группы доступны в разделе «Походы».'}</p>
      <RouteSources trail={trail}/>
      <h3>Отзывы</h3>
      <p>{trail.publicationStatus === 'reference' ? 'Походы по этой справочной карточке ещё не опубликованы.' : 'Отзывы доступны на странице конкретного похода.'} Оценку можно оставить после завершённого выхода и подтверждения участия.</p>
      {related.length > 0 && <section className="seo-related" aria-labelledby="related-routes-heading">
        <h3 id="related-routes-heading" className="heading-6">{localRelated.length ? 'Другие маршруты этого направления' : 'Ещё маршруты в каталоге'}</h3>
        <ul className="seo-route-list">{related.map(item => <li key={item.id}>
          <a href={canonicalUrl('/routes/' + encodeURIComponent(item.id) + '/', context)}>
            <strong className="title-2">{item.title}</strong>
            <span className="button-sm">Карта и описание <ArrowRight size={18}/></span>
          </a>
        </li>)}</ul>
      </section>}
      <div className="section-actions">{seo.links.map(item => <a className="button secondary" href={item.url} key={item.url}>{item.name} <ArrowRight size={18}/></a>)}</div>
    </article>
    {process.env.NEXT_PUBLIC_STATIC_EXPORT !== 'true' && <script type="application/ld+json" dangerouslySetInnerHTML={{__html: serializeJsonLd(seo.structuredData)}}/>}
  </main><Footer/></>;
}
