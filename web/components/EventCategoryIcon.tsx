import type {CSSProperties} from 'react';
import {eventCategoryById, type EventCategoryId} from '@/lib/event-categories';

/** Original Tropnik drawings. 28 × 28 grid; round joins and open trails match MapIcon. */
export const eventCategoryPaths: Record<EventCategoryId, readonly string[]> = {
  walk: ['M6 24c0-4 3-5 6-5s5-2 5-5', 'M9 10c1-3 4-4 6-2l3 3 5 1', 'm13 9-2 7 5 4 2 5m-7-9-5 4', 'M17 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z'],
  trek: ['M8 8a6 6 0 0 1 12 0v17H8V8Z', 'M11 3V1h6v2M8 12H5v9h3m12-9h3v9h-3', 'M11 16h6v6h-6v-6Zm0-6h6', 'M3 25h22'],
  summit: ['m3 24 11-20 11 20H3Z', 'm10 11 4 3 4-3', 'M14 4V1m7 4 2-2M7 5 5 3', 'm10 24 4-6 4 6'],
  pass: ['m2 23 6-14 6 8 6-8 6 14', 'M8 5v4m12-4v4', 'M14 26v-7m0-6V9', 'm11 12 3-3 3 3'],
  lake: ['m3 13 5-7 5 7m4-2 4-6 4 8', 'M25 18c0 3-5 6-11 6S3 21 3 18s5-4 11-4 11 1 11 4Z', 'M8 18h5m3 3h4'],
  waterfall: ['M3 5h9v4m0-4h13', 'M12 9v10c0 2-2 3-4 3m8-17v15m4-15v13', 'M3 25h22', 'M5 13h3m14 9h2M4 18h3'],
  forest: ['m10 3 6 8h-3l5 8H2l5-8H4l6-8Z', 'M10 15v11m10-18 5 7h-3l4 6H17m3-3v8', 'M6 26h18'],
  coast: ['M3 5h8l-2 7 5 5-3 8', 'M16 6c2-2 5-2 8 0m-9 6c3-2 6-2 10 0m-7 6c2-1 4-1 6 0', 'M3 18h3m-2 4h2'],
  volcano: ['m3 24 7-13h8l7 13H3Z', 'm10 11 4 3 4-3m-4 3-2 5 3 5', 'M11 7c-3-4 3-4 1-6m5 6c3-3-2-4 1-6', 'M4 8 2 6m22 2 2-2'],
  camp: ['m4 23 10-18 10 18H4Z', 'm10 23 4-8 4 8M11 2l3 3 3-3', 'M2 26h24', 'M22 4v4m-2-2h4'],
  meetup: ['M11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm12 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z', 'M3 19v-2a5 5 0 0 1 10 0m2 0a5 5 0 0 1 10 0v2', 'M4 23c5-3 15-3 20 0m-14 2h8', 'm12 4 2-2 2 2'],
  training: ['M3 5c4-1 8 0 11 3 3-3 7-4 11-3v18c-4-1-8 0-11 3-3-3-7-4-11-3V5Z', 'M14 8v18', 'm6 16 3-5 3 5H6Z', 'M18 11h4m-4 4h4m-4 4h2'],
};
export function EventCategoryIcon({category, size = 24, label, decorative = true, className = ''}: {category: EventCategoryId; size?: number; label?: string; decorative?: boolean; className?: string}) {
  const accessibleLabel = label || eventCategoryById[category].label;
  return <svg className={`event-category-icon ${className}`.trim()} width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden={decorative ? true : undefined} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : accessibleLabel} focusable="false" data-event-category={category} style={{'--event-icon-size': `${size}px`} as CSSProperties}>{eventCategoryPaths[category].map((d, index) => <path d={d} key={index}/>)}</svg>;
}
export function EventCategoryBadge({category, size = 24}: {category: EventCategoryId; size?: number}) {
  const definition = eventCategoryById[category];
  return <span className={`event-category-badge event-category-tone-${definition.tone} caption-4`} data-event-category={category}><EventCategoryIcon category={category} size={size}/><span>{definition.shortLabel}</span></span>;
}
export function RouteCategoryBadges({categories, limit = 3, className = ''}: {categories: readonly EventCategoryId[]; limit?: number; className?: string}) {
  const visible = categories.slice(0, limit);
  if (!visible.length) return null;
  return <span className={`route-categories ${className}`.trim()} aria-label="Особенности маршрута">{visible.map(category => <EventCategoryBadge key={category} category={category}/>)}</span>;
}
