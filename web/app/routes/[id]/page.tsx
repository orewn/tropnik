import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {ArrowSquareOut} from '@/components/TropnikIcons';
import {SourceDifficulty} from '@/components/SourceDifficulty';
import {RouteSources} from '@/components/RouteSources';
import {Header} from '@/components/Header';
import {Footer} from '@/components/Footer';
import {Explore} from '@/components/Explore';
import {getPublishedTrail} from '@/lib/server';
import {trailById, isPublicIndexingEnabled} from '@/lib/content';
import {mapRegionById} from '@/lib/territories';
import {formatEvidenceDate, sourceDateLabel, trailGeometryDescription} from '@/lib/trail-evidence';

export async function generateMetadata({params}: {params: Promise<{id: string}>}): Promise<Metadata> {
  const {id} = await params;
  const trail = trailById(id) || await getPublishedTrail(id);
  return trail ? {
    title: trail.title,
    description: trail.description,
    alternates: {canonical: `/routes/${id}`},
    robots: {index: isPublicIndexingEnabled() && trail.publicationStatus === 'published', follow: true},
  } : {title: 'Маршрут не найден'};
}

export default async function RoutePage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  const trail = trailById(id) || await getPublishedTrail(id);
  if (!trail) notFound();
  return <><Header/><main id="main">
    <Explore initialPublished={trail.publicationStatus === 'published' ? [trail] : []} initialRegion={trail.regionId} initialTrail={trail.id}/>
    <article className="region-article">
      <span className="eyebrow">Паспорт маршрута · {mapRegionById(trail.regionId)?.name}</span>
      <h2>{trail.title}</h2>
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
    </article>
  </main><Footer/></>;
}
