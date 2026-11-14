import type {Region, Trail} from './content';
import {BRAND} from './brand';

/** One presentation model for server pages, the static export and search metadata. */
export type SeoContext = {siteUrl: string; publicIndexing: boolean; trailingSlash?: boolean};
export type SeoLink = {name: string; path: string; url: string; description?: string};
export type SeoFact = {label: string; value: string; note?: string};
export type SeoSource = {name: string; url: string; checkedAt?: string};
export type SeoPage = {
  kind: string; path: string; id?: string; title: string; description: string;
  canonical: string; indexable: boolean; heading: string; siteName: string; image: string;
  breadcrumbs: SeoLink[]; paragraphs: string[]; facts: SeoFact[]; limitations: string[];
  sources: SeoSource[]; links: SeoLink[]; structuredData: Record<string, unknown>[];
};

const text = (value: unknown): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : '';
const summary = (value: string, length = 210): string => {
  const clean = text(value);
  if (clean.length <= length) return clean;
  const end = clean.slice(0, length - 1);
  const boundary = end.lastIndexOf(' ');
  return (boundary > length / 2 ? end.slice(0, boundary) : end) + '…';
};
const uniqueText = (values: unknown[]): string[] => [...new Set(values.map(text).filter(Boolean))];

/** Reject executable, credential-bearing and malformed source links. */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password
      ? url.href : null;
  } catch { return null; }
}

function siteRoot(context: SeoContext): URL {
  const safe = safeExternalUrl(context.siteUrl);
  if (!safe) throw new Error('SEO siteUrl must be an absolute HTTP(S) URL without credentials.');
  const site = new URL(safe);
  if (site.search || site.hash) throw new Error('SEO siteUrl must not contain a query or fragment.');
  site.pathname = site.pathname.replace(/\/+$/, '') + '/';
  return site;
}

/** Application-local paths stay stable; the deployment base is added exactly once. */
export function canonicalUrl(path: string, context: SeoContext): string {
  const site = siteRoot(context);
  if (!path.startsWith('/') || path.startsWith('//') || /[\u0000-\u0020\u007f\\]/.test(path)) {
    throw new Error('SEO page paths must be application-local absolute paths.');
  }
  let pathname = path.split(/[?#]/, 1)[0];
  for (const segment of pathname.split('/')) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { throw new Error('Invalid encoded SEO path.'); }
    if (decoded === '.' || decoded === '..' || /[\\\u0000-\u001f\u007f]/.test(decoded)) {
      throw new Error('SEO page path cannot escape the deployment base.');
    }
  }
  const base = site.pathname;
  if (base !== '/' && (pathname === base.slice(0, -1) || pathname.startsWith(base))) {
    pathname = '/' + pathname.slice(base.length).replace(/^\/+/, '');
  }
  pathname = pathname.replace(/\/{2,}/g, '/');
  const file = /\.[a-z0-9]{1,12}$/i.test(pathname);
  if (pathname !== '/' && !file) pathname = pathname.replace(/\/+$/, '') + (context.trailingSlash === false ? '' : '/');
  return new URL(pathname.slice(1), site).href;
}

const pagePath = (kind: string, id?: string): string => '/' + kind + (id === undefined ? '' : '/' + encodeURIComponent(id)) + '/';
const link = (name: string, path: string, context: SeoContext, description?: string): SeoLink => ({
  name: text(name), path, url: canonicalUrl(path, context), ...(description ? {description: text(description)} : {}),
});
const homeLink = (context: SeoContext) => link('Карта маршрутов', '/', context);
const catalogueLink = (context: SeoContext) => link('Каталог маршрутов', pagePath('routes'), context);
const realRegions = (regions: readonly Region[]): Region[] => regions.filter(region => !region.id.startsWith('territory-'));
const belongsTo = (trail: Trail, id: string): boolean => trail.regionId === id || !!trail.regionIds?.includes(id);
const namedRoute = (trail: Trail): boolean => {
  const name = text(trail.title);
  return name.length >= 3 && !/^(?:тропа без названия|без названия|маршрут\s+(?:osm\s+)?\d+\s*$)/iu.test(name);
};
const genericDescription = (value: string): boolean => /^(?:Пеший маршрут (?:по сведениям из открытой карты|из открытой базы OpenStreetMap)|Описание (?:маршрута|тропы) (?:отсутствует|уточняется))/iu.test(text(value));

/** Search readiness is evidence quality, not booking/publication availability. */
export function isRouteSeoEligible(trail: Trail): boolean {
  if (!namedRoute(trail) || !text(trail.id) || !safeExternalUrl(trail.sourceUrl) || !text(trail.checkedAt)) return false;
  const description = text(trail.description);
  if (description.length < 60 || genericDescription(description)) return false;
  if (trail.sourceKind !== 'database') return true;
  if (safeExternalUrl(trail.officialEvidence?.url) && text(trail.officialEvidence?.summary).length >= 30
    && text(trail.officialEvidence?.checkedAt)) return true;
  return !!trail.additionalSources?.some(source => ['official_description', 'editorial_mention'].includes(source.scope)
    && !!safeExternalUrl(source.url) && !!text(source.reviewedAt));
}

const allEligible = (trails: readonly Trail[]): Trail[] => [...new Map(trails
  .filter(isRouteSeoEligible).map(trail => [trail.id, trail])).values()]
  .sort((a, b) => a.title.localeCompare(b.title, 'ru') || a.id.localeCompare(b.id));

function complete(page: Omit<SeoPage, 'canonical' | 'siteName' | 'image' | 'structuredData'>, context: SeoContext): SeoPage {
  const canonical = canonicalUrl(page.path, context);
  const home = canonicalUrl('/', context);
  const image = canonicalUrl('/og-cover.png', context);
  const graph: Record<string, unknown>[] = [];
  if (page.kind === 'home') graph.push({
    '@context': 'https://schema.org', '@type': 'WebSite', '@id': home + '#website',
    url: home, name: BRAND.name, alternateName: BRAND.latinName, inLanguage: 'ru-RU',
  });
  graph.push({
    '@context': 'https://schema.org', '@type': ['region', 'catalogue'].includes(page.kind) ? 'CollectionPage' : 'WebPage',
    '@id': canonical + '#webpage', url: canonical, name: page.heading, description: page.description,
    inLanguage: 'ru-RU', isPartOf: {'@id': home + '#website'},
  });
  if (page.breadcrumbs.length > 1) graph.push({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: page.breadcrumbs.map((crumb, index) => ({
      '@type': 'ListItem', position: index + 1, name: crumb.name, item: crumb.url,
    })),
  });
  return {...page, canonical, siteName: BRAND.name, image, structuredData: graph};
}

export function homeSeo(context: SeoContext, regions: readonly Region[] = [], trails: readonly Trail[] = []): SeoPage {
  const heading = 'Пешие маршруты и походы по России';
  const description = 'Найдите пеший маршрут по России: выберите регион, сравните известные параметры тропы и изучите карту, описание и условия посещения.';
  return complete({
    kind: 'home', path: '/', title: `${BRAND.name} — пешие маршруты и походы по России`, heading, description,
    indexable: context.publicIndexing, breadcrumbs: [],
    paragraphs: [description, 'В справочных карточках указаны источники сведений и ограничения. Наличие маршрута на карте не подтверждает открытие территории или готовность пути к прохождению.'],
    facts: [], limitations: [], sources: [],
    links: [catalogueLink(context), ...realRegions(regions).filter(region => !trails.length || trails.some(trail => belongsTo(trail, region.id)))
      .map(region => link(region.name, pagePath('regions', region.id), context, region.description))],
  }, context);
}

export function catalogueSeo(trails: readonly Trail[], regions: readonly Region[], context: SeoContext): SeoPage {
  const eligible = allEligible(trails);
  const knownRegions = realRegions(regions);
  const heading = 'Пешие маршруты России';
  const description = 'Каталог пеших маршрутов России с описаниями, источниками и известными параметрами. Выберите тропу и уточните условия перед выходом.';
  return complete({
    kind: 'catalogue', path: pagePath('routes'), title: `Пешие маршруты России: каталог троп — ${BRAND.name}`, heading, description,
    indexable: context.publicIndexing && eligible.length > 0,
    breadcrumbs: [homeLink(context), catalogueLink(context)], paragraphs: [description], facts: [],
    limitations: ['Справочное описание не заменяет проверку доступа, погоды и состояния тропы перед походом.'], sources: [],
    links: eligible.map(trail => {
      const region = knownRegions.find(value => value.id === trail.regionId)
        || knownRegions.find(value => belongsTo(trail, value.id));
      return link(trail.title, pagePath('routes', trail.id), context,
        [region?.name, summary(trail.description, 150)].filter(Boolean).join(' · '));
    }),
  }, context);
}

export function regionSeo(region: Region, trails: readonly Trail[], context: SeoContext): SeoPage {
  const eligible = allEligible(trails.filter(trail => belongsTo(trail, region.id)));
  const heading = `Пешие маршруты: ${text(region.name)}`;
  const path = pagePath('regions', region.id);
  const description = summary(`${region.name}: пешие маршруты и тропы. ${region.description}`);
  return complete({
    kind: 'region', id: region.id, path, title: `${heading} — ${BRAND.name}`, heading, description,
    indexable: context.publicIndexing && !region.id.startsWith('territory-') && eligible.length > 0,
    breadcrumbs: [homeLink(context), catalogueLink(context), link(region.name, path, context)],
    paragraphs: [text(region.description), 'Сравнивайте длину, набор высоты, покрытие и технические участки. Смотрите дату сведений. Если сложность ещё не подтверждена, отсутствие оценки не означает лёгкую прогулку.'],
    facts: [], limitations: [], sources: [],
    links: eligible.map(trail => link(trail.title, pagePath('routes', trail.id), context, summary(trail.description, 150))),
  }, context);
}

function routeSources(trail: Trail): SeoSource[] {
  const entries: SeoSource[] = [];
  const append = (name: string, rawUrl: unknown, checkedAt?: string) => {
    const url = safeExternalUrl(rawUrl);
    if (url && !entries.some(source => source.url === url)) entries.push({name: text(name) || 'Источник сведений', url, ...(checkedAt ? {checkedAt: text(checkedAt)} : {})});
  };
  append(trail.sourceName, trail.sourceUrl, trail.checkedAt);
  if (trail.officialEvidence) append('Официальное описание', trail.officialEvidence.url, trail.officialEvidence.checkedAt);
  // effectiveAt dates a notice, not our review of its source. Its date stays in the notice text.
  if (trail.operatingNotice) append(trail.operatingNotice.title || 'Сообщение об условиях посещения', trail.operatingNotice.url);
  for (const source of trail.additionalSources || []) append(source.name, source.url, source.reviewedAt);
  return entries;
}

function geometryLimitation(trail: Trail): string {
  if (!trail.geometryUrl && !trail.geometry) return 'Линия пути пока не добавлена. Карточка содержит описание, а не готовый навигационный трек.';
  if (trail.geometrySourceKind === 'official') return trail.geometryScope === 'source_scheme'
    ? 'На карте показана схема организации, отвечающей за маршрут. Для навигации нужна подробная карта и проверка условий перед выходом.'
    : 'Линия пути опубликована организацией, отвечающей за маршрут. Действующие ограничения и состояние тропы проверяются перед выходом.';
  return 'Полнота линии на карте и её соответствие пути на местности требуют отдельной проверки.';
}

export function routeSeo(trail: Trail, regions: readonly Region[], context: SeoContext): SeoPage {
  const path = pagePath('routes', trail.id);
  const knownRegions = realRegions(regions);
  const region = knownRegions.find(value => value.id === trail.regionId)
    || knownRegions.find(value => belongsTo(trail, value.id));
  const heading = text(trail.title);
  const facts: SeoFact[] = [
    {label: 'Длина по источнику', value: Number.isFinite(trail.distanceKm) && trail.distanceKm !== null && trail.distanceKm >= 0 ? `${trail.distanceKm.toLocaleString('ru-RU')} км` : 'Не подтверждена', ...(trail.distanceNote ? {note: text(trail.distanceNote)} : {})},
    {label: 'Время по источнику', value: text(trail.duration) || 'Не подтверждено'},
    {label: 'Сложность', value: text(trail.difficultyLabel) || 'Требует проверки'},
    {label: 'Набор высоты', value: Number.isFinite(trail.ascentM) && trail.ascentM !== null && trail.ascentM >= 0 ? `${trail.ascentM.toLocaleString('ru-RU')} м` : 'Не подтверждён'},
    {label: 'Условия посещения', value: trail.accessStatus === 'closed' ? 'По имеющимся сведениям закрыто' : trail.accessStatus === 'restricted' ? 'Есть ограничения' : 'Уточните перед выходом'},
  ];
  if (text(trail.season)) facts.push({label: 'Сезон', value: text(trail.season)});
  if (text(trail.checkedAt)) facts.push({label: trail.sourceKind === 'database' ? 'Данные загружены' : trail.sourceKind === 'community' ? 'Источник рассмотрен' : 'Описание прочитано', value: text(trail.checkedAt)});
  const limitations = uniqueText([
    geometryLimitation(trail), 'Карточка не подтверждает открытие территории на выбранную дату.',
    ...(trail.notes || []),
    ...(trail.operatingNotice ? [`${trail.operatingNotice.title}. ${trail.operatingNotice.body}`] : []),
  ]);
  return complete({
    kind: 'route', id: trail.id, path, heading, title: `${heading}: карта и описание — ${BRAND.name}`,
    description: summary(`${heading}. ${trail.description}`), indexable: context.publicIndexing && isRouteSeoEligible(trail),
    breadcrumbs: [homeLink(context), catalogueLink(context), ...(region ? [link(region.name, pagePath('regions', region.id), context)] : []), link(heading, path, context)],
    paragraphs: uniqueText([trail.description, trail.officialEvidence?.summary]), facts, limitations,
    sources: routeSources(trail), links: [catalogueLink(context), ...(region ? [link(`Другие маршруты: ${region.name}`, pagePath('regions', region.id), context)] : [])],
  }, context);
}

export function infoSeo(kind: string, title: string, context: SeoContext): SeoPage {
  const about = kind === 'about';
  const heading = about ? `О ${BRAND.name.replace(/ыч$/, 'ыче')}` : text(title);
  const path = ['missing', '404'].includes(kind) ? '/404.html' : pagePath(kind);
  const description = about
    ? `${BRAND.name} — карта пеших маршрутов России. Как устроены каталог, источники сведений и подготовка к походу.`
    : `${text(title)} — ${BRAND.name}.`;
  return complete({
    kind, path, title: `${text(title)} — ${BRAND.name}`, heading, description,
    indexable: context.publicIndexing && about,
    breadcrumbs: [homeLink(context), link(heading, path, context)],
    paragraphs: about ? [
      `${BRAND.previousName} теперь называется ${BRAND.name}. Карта, сохранённые маршруты и подготовка к походу остаются в одном сервисе.`,
      'Большая карта помогает выбрать направление и приблизиться к конкретному маршруту. В карточке собраны известные параметры, источники сведений о пути и ограничения.',
      'Мы различаем наличие линии в открытой базе, официальное описание маршрута, актуальные ограничения, соответствие линии реальному пути и проверку на местности. Один источник не закрывает все эти вопросы.',
    ] : ['Для работы с этим разделом откройте интерактивную версию сайта.'],
    facts: [], limitations: [], sources: [], links: [catalogueLink(context)],
  }, context);
}

/** Safe for inline application/ld+json, including hostile catalogue text. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
