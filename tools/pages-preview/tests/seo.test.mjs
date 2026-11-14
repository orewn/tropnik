import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadSeoModule, renderSeoHead, renderStaticContent, renderSitemap, renderRobots} from '../seo.mjs';

const web = fileURLToPath(new URL('../../../web/', import.meta.url));
const seo = await loadSeoModule(web);
const context = {siteUrl: 'https://orewn.github.io/tropnik/', publicIndexing: true, trailingSlash: true};
const region = {id: 'altai', name: 'Алтай', description: 'Горные маршруты Алтая с описаниями и известными параметрами пути.'};
const curated = {
  id: 'katun-lake', regionId: 'altai', title: 'Тропа к Верхнему озеру', subtitle: 'Катунский заповедник',
  description: 'Тропа идёт от устья реки через лесные участки и поляны к Верхнему озеру. Обратный путь проходит по тому же маршруту.',
  distanceKm: 6, duration: null, ascentM: null, difficulty: 'unknown', difficultyLabel: 'Требует проверки',
  sourceUrl: 'https://example.org/trail', sourceName: 'Заповедник', checkedAt: '2026-11-06',
  sourceKind: 'official', publicationStatus: 'reference', season: 'Уточнить перед выходом', notes: [],
};
const generic = {...curated, id: 'database-path', sourceKind: 'database', title: 'Лесная тропа',
  description: 'Пеший маршрут по сведениям из открытой карты. На пути могут встречаться развилки и участки без описания. Перед выходом уточните состояние тропы и правила посещения.'};

test('reference eligibility depends on useful evidence, not published or bookable status', () => {
  assert.equal(seo.isRouteSeoEligible(curated), true);
  assert.equal(seo.routeSeo(curated, [region], context).indexable, true);
  assert.equal(seo.isRouteSeoEligible({...generic, publicationStatus: 'published'}), false);
  assert.equal(seo.routeSeo(curated, [region], {...context, publicIndexing: false}).indexable, false);
  assert.equal(seo.isRouteSeoEligible({...curated, sourceKind: 'database'}), false);
  assert.equal(seo.isRouteSeoEligible({...curated, sourceKind: 'database', officialEvidence: {url: 'https://example.org/official', checkedAt: '2026-11-06', summary: 'Официальное описание тропы с известными участками пути и ограничениями.'}}), true);
  assert.equal(seo.isRouteSeoEligible({...curated, title: 'Тропа без названия · Алтай'}), false);
  assert.equal(seo.isRouteSeoEligible({...curated, sourceUrl: 'javascript:alert(1)'}), false);
});

test('canonical URLs keep deployment base once, remove query variants and preserve file URLs', () => {
  assert.equal(seo.canonicalUrl('/routes/katun-lake?layer=satellite#map', context), 'https://orewn.github.io/tropnik/routes/katun-lake/');
  assert.equal(seo.canonicalUrl('/tropnik/routes/katun-lake/', context), 'https://orewn.github.io/tropnik/routes/katun-lake/');
  assert.equal(seo.canonicalUrl('/', context), 'https://orewn.github.io/tropnik/');
  assert.equal(seo.canonicalUrl('/og-cover.png', context), 'https://orewn.github.io/tropnik/og-cover.png');
  assert.equal(seo.canonicalUrl('/routes/katun-lake/', {...context, siteUrl: 'https://example.org', trailingSlash: false}), 'https://example.org/routes/katun-lake');
  assert.throws(() => seo.canonicalUrl('//evil.test/path', context));
  assert.throws(() => seo.canonicalUrl('/%2e%2e/private', context));
  assert.throws(() => seo.canonicalUrl('/', {...context, siteUrl: 'https://user:password@example.org/'}));
});

test('missing territorial landing pages never appear in route navigation or schema', () => {
  const page = seo.routeSeo({...curated, regionId: 'territory-999'}, [region, {id: 'territory-999', name: 'Не опубликованный регион'}], context);
  assert.deepEqual(page.breadcrumbs.map(crumb => crumb.path), ['/', '/routes/', '/routes/katun-lake/']);
  assert.ok(!JSON.stringify(page).includes('/regions/territory-'));
  assert.equal(page.indexable, true);
  const alternative = seo.routeSeo({...curated, regionId: 'territory-999', regionIds: ['altai']}, [region], context);
  assert.ok(alternative.breadcrumbs.some(crumb => crumb.path === '/regions/altai/'));
});

test('regions and catalogue expose useful routes, including references, without duplicate IDs', () => {
  assert.equal(seo.regionSeo(region, [generic], context).indexable, false);
  const page = seo.regionSeo(region, [curated, curated, generic], context);
  assert.equal(page.indexable, true);
  assert.deepEqual(page.links.map(item => item.path), ['/routes/katun-lake/']);
  const catalogue = seo.catalogueSeo([generic, curated, {...curated, id: 'another', title: 'Альпийская тропа'}], [region], context);
  assert.equal(catalogue.indexable, true);
  assert.deepEqual(catalogue.links.map(item => item.name), ['Альпийская тропа', curated.title]);
  const homepage = seo.homeSeo(context, [region, {id: 'territory-999', name: 'Территория'}]);
  assert.equal(homepage.links.length, 2);
  assert.equal(homepage.links[0].path, '/routes/');
});

test('metadata, visible fallback and JSON-LD escape hostile input and reject executable links', () => {
  const hostile = {...curated, title: '</script><script>alert("x")</script>', description: 'Описание " onclick="alert(1) <img src=x onerror=alert(1)> с реальными сведениями о пути и местах на маршруте.',
    sourceUrl: 'javascript:alert(1)', officialEvidence: {url: 'data:text/html,test', checkedAt: '2026-11-06', summary: '</script>'},
    additionalSources: [{url: 'https://user:pass@evil.test/path', name: 'Credentials', reviewedAt: '2026-11-06', scope: 'official_description'}], notes: ['<script>alert(1)</script>']};
  const page = seo.routeSeo(hostile, [region], context);
  const head = renderSeoHead(page), body = renderStaticContent(page, {base: '/tropnik/'});
  assert.ok(head.includes('&lt;/script&gt;'));
  assert.ok(!head.includes('<script>alert'));
  assert.ok(!body.includes('<script>'));
  const images = body.match(/<img\b[^>]*>/g) || [];
  assert.deepEqual(images, ['<img src="/tropnik/brand-mark.svg" width="40" height="40" alt="">']);
  assert.ok(body.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the hostile image remains escaped text');
  assert.ok(!/<[^>]+\bon(?:error|click)\s*=/i.test(body), 'hostile event handlers cannot become HTML attributes');
  assert.ok(!body.includes('href="javascript:'));
  assert.equal(page.sources.length, 0);
  for (const block of head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => JSON.parse(block[1]));
  assert.equal(seo.safeExternalUrl('https://example.org/a\nb'), null);
  assert.equal(seo.safeExternalUrl('//example.org/path'), null);
  assert.equal((body.match(/<h1\b[^>]*>/g) || []).length, 1);
  assert.ok(body.includes('https://orewn.github.io/tropnik/routes/'));
  assert.ok(!body.includes('display:none'));
});

test('the static map placeholder keeps one document heading outside the collapsed mobile sheet', () => {
  for (const page of [seo.homeSeo(context, [region]), seo.regionSeo(region, [curated], context), seo.routeSeo(curated, [region], context), seo.catalogueSeo([curated], [region], context), seo.infoSeo('about', 'О проекте', context)]) {
    const body = renderStaticContent(page, {base: '/tropnik/'});
    assert.equal((body.match(/<h1\b[^>]*>/g) || []).length, 1, page.kind);
    const article = body.match(/<article id="static-description"[^>]*>([\s\S]*)<\/article>/)?.[1];
    assert.ok(article && /<h1\b/.test(article), 'the no-JS article owns the visible page heading');
    const hasMap = ['home', 'region', 'route'].includes(page.kind);
    assert.equal(body.includes('class="explore-layout sheet-closed"'), hasMap);
    assert.equal(body.includes('<div class="sheet-handle" aria-hidden="true"><span></span></div>'), hasMap);
    assert.equal(body.includes('<a class="sheet-peek-summary" href="#static-description"><span class="sheet-peek-copy">'), hasMap);
    assert.ok(!body.includes('<button'), 'the no-JS sheet provides ordinary links, not inactive controls');
    assert.ok(!/<aside[^>]*>[\s\S]*?<h1\b[\s\S]*?<\/aside>/.test(body));
    assert.ok(body.includes('href="/tropnik/routes/"'));
  }
});

test('sitemap includes only indexable canonical pages; service pages stay noindex', () => {
  const pages = [seo.homeSeo(context), seo.routeSeo(curated, [region], context), seo.routeSeo(generic, [region], context), seo.infoSeo('about', 'О проекте', context), seo.infoSeo('account', 'Личный кабинет', context)];
  const xml = renderSitemap([...pages, pages[0]]);
  assert.equal((xml.match(/<url>/g) || []).length, 3);
  assert.ok(!xml.includes('database-path'));
  assert.ok(!xml.includes('account'));
  assert.ok(!xml.includes('<lastmod>'));
  for (const kind of ['search', 'planner', 'offline', 'preview', '404', 'missing', 'safety', 'sources', 'account/action']) {
    const page = seo.infoSeo(kind, kind, context);
    assert.equal(page.indexable, false);
    assert.match(renderSeoHead(page), /noindex,follow/);
  }
  assert.equal(renderSitemap(pages.map(page => ({...page, indexable: false}))).includes('<url>'), false);
});

test('robots identifies subdirectory limitation and points at the sitemap without doubling base', () => {
  const robots = renderRobots({siteUrl: context.siteUrl, base: '/tropnik/', publicIndexing: true});
  assert.match(robots, /Crawlers use \/robots.txt at the host root/);
  assert.match(robots, /Sitemap: https:\/\/orewn.github.io\/tropnik\/sitemap.xml/);
  assert.ok(!robots.includes('tropnik/tropnik'));
  assert.match(renderRobots({siteUrl: 'https://example.org', base: '/', publicIndexing: false}), /Disallow: \//);
  assert.equal(renderRobots({siteUrl: 'https://example.org', base: '/', publicIndexing: true}).startsWith('User-agent:'), true);
});
