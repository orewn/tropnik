/** Geometry provenance is separate from the official description of a route. */
export function nativeGeometryProvenance(trail, hasGeometry) {
  const official = hasGeometry && trail.geometrySourceKind === 'official';
  const name = trail.geometrySourceName || trail.sourceName;
  const license = trail.geometrySourceLicense;
  return {
    sourceLicense: !hasGeometry
      ? 'Описание с указанным источником. Линия маршрута пока не добавлена.'
      : official
        ? `Геометрия: ${name}. ${!license || license === 'not-stated' ? 'Открытая лицензия источником не указана.' : license}`
        : 'Геометрия: © OpenStreetMap contributors, ODbL 1.0. Независимое описание с указанным источником.',
    geometrySourceKind: hasGeometry ? trail.geometrySourceKind || 'database' : null,
    geometrySourceName: hasGeometry ? trail.geometrySourceName ?? null : null,
    geometrySourceUrl: hasGeometry ? trail.geometrySourceUrl ?? null : null,
    geometrySourceLicense: hasGeometry ? license ?? null : null,
    geometryScope: hasGeometry ? trail.geometryScope ?? null : null,
    geometryReviewedAt: hasGeometry ? trail.geometryReviewedAt ?? null : null,
  };
}
