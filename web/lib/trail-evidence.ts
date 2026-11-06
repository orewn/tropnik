type GeometryEvidence = {
  publicationStatus: 'reference' | 'published';
  sourceKind?: string;
  geometryUrl?: string;
  geometry?: unknown;
};

/** Explain only geometry actually supplied with the record. */
export function trailGeometryDescription(trail: GeometryEvidence): string {
  if (!trail.geometryUrl && !trail.geometry) {
    return 'Линия пути пока не добавлена. Сохранить можно описание маршрута; для навигации потребуется проверенная карта.';
  }
  if (trail.publicationStatus === 'published') {
    return 'На карте показан опубликованный путь. Новые изменения и ограничения проверяются перед каждым выходом.';
  }
  if (trail.sourceKind === 'community') {
    return 'Линия пути получена из указанного источника сообщества. Её полнота и соответствие маршруту на местности требуют отдельной проверки.';
  }
  return 'Линия пути взята из OpenStreetMap. Её полнота и соответствие маршруту на местности ещё не проверены.';
}

export function sourceDateLabel(kind?: string): string {
  if (kind === 'community') return 'Источник рассмотрен';
  return kind === 'database' ? 'Данные загружены' : 'Описание прочитано';
}

export function formatEvidenceDate(value?: string): string {
  if (!value) return 'Дата не указана';
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('ru', {timeZone: 'Europe/Moscow'})
    : 'Дата не указана';
}

export function safeSourceHref(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href : null;
  } catch {
    return null;
  }
}
