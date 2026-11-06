import {ArrowSquareOut} from '@/components/TropnikIcons';
import type {Trail} from '@/lib/content';
import {formatEvidenceDate, safeSourceHref} from '@/lib/trail-evidence';

export function RouteSources({trail}: {trail: Trail}) {
  const primary = safeSourceHref(trail.sourceUrl);
  const seen = new Set<string>();
  const references = (trail.additionalSources || []).filter(source => {
    const href = safeSourceHref(source.url);
    if (!href || seen.has(href)) return false;
    seen.add(href);
    return true;
  });
  const detailedPrimary = references.some(source => safeSourceHref(source.url) === primary);
  return <section aria-label="Источники маршрута">
    <h3>Источники маршрута</h3>
    {!detailedPrimary && <p>{primary
      ? <a href={primary} target="_blank" rel="noopener noreferrer">{trail.sourceName} <ArrowSquareOut size={18}/></a>
      : trail.sourceName}</p>}
    {references.length > 0 && <ul>{references.map(source => <li key={source.url}>
      <a href={safeSourceHref(source.url)!} target="_blank" rel="noopener noreferrer">{source.name} <ArrowSquareOut size={18}/></a>
      <p>{source.publishedAt && <>Опубликовано {formatEvidenceDate(source.publishedAt)}. </>}Прочитано {formatEvidenceDate(source.reviewedAt)}.
        {source.scope === 'community_mention' && ' Упоминание в сообществе; условия и путь требуют проверки.'}
        {source.scope === 'editorial_mention' && ' Подборка для знакомства с направлением.'}
        {source.scope === 'official_description' && ' Описание от организации, отвечающей за маршрут.'}
        {source.scope === 'geometry_download' && ' Файл пути от автора. Его соответствие местности ещё не проверено.'}
      </p>
    </li>)}</ul>}
  </section>;
}
