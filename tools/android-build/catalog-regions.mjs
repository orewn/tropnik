/** Preserve tourism collections and exact geographic membership in the native catalogue. */
export function nativeCatalogueRegions(curatedRegions, territories, trails) {
  const validId = id => typeof id === 'string' && /^(?:[a-z0-9-]{1,64}|territory-[A-Za-z0-9]{1,54})$/.test(id);
  const curated = new Map(curatedRegions.map(region => [region.id, region]));
  const geographic = new Map(territories.map(region => [region.id, region]));
  if (curated.size !== curatedRegions.length || geographic.size !== territories.length
      || [...curated.keys()].some(id => geographic.has(id))
      || [...curated.keys(), ...geographic.keys()].some(id => !validId(id))) throw new Error('Invalid catalogue region identity');
  const byGeometry = new Map();
  for (const territory of territories) {
    if (!territory.id.startsWith('territory-') || !Array.isArray(territory.geometryUrls)) throw new Error('Invalid geographic region record');
    for (const url of territory.geometryUrls) {
      const ids = byGeometry.get(url) || new Set();
      ids.add(territory.id); byGeometry.set(url, ids);
    }
  }
  const usedTerritories = new Set();
  const memberships = new Map();
  for (const trail of trails) {
    const declared = trail.regionIds?.length ? trail.regionIds : [trail.regionId];
    if (!declared.includes(trail.regionId) || declared.some(id => !curated.has(id) && !geographic.has(id))) throw new Error(`Unknown region for ${trail.id}`);
    const located = trail.territoryIds || [];
    if (!Array.isArray(located) || located.some(id => !geographic.has(id))) throw new Error(`Unknown territory for ${trail.id}`);
    const ids = [...new Set([...declared, ...located, ...(byGeometry.get(trail.geometryUrl) || [])])];
    ids.filter(id => geographic.has(id)).forEach(id => usedTerritories.add(id));
    if (memberships.has(trail.id)) throw new Error(`Duplicate route ${trail.id}`);
    memberships.set(trail.id, ids);
  }
  const additional = territories.filter(region => usedTerritories.has(region.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru')).map(region => ({
      id: region.id, name: region.name, center: region.center, zoom: 6, territory: true,
      caption: 'Карта территории и маршруты каталога.',
      description: 'Маршруты отнесены к территории по исходной линии или описанию места. Перед выходом проверьте состояние тропы и правила посещения.',
    }));
  return {regions: [...curatedRegions.map(region => ({...region, territory: false})), ...additional], memberships};
}
