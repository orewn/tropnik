import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ts} from './paths.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const safeUrl = value => {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
};
const jsonLd = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Load only the small audited presentation graph; content.ts is a type-only dependency. */
export async function loadSeoModule(webRoot) {
  const modules = new Map();
  async function compile(name) {
    if (modules.has(name)) return modules.get(name);
    if (!['seo', 'brand'].includes(name)) throw new Error(`Unexpected SEO module: ${name}`);
    let code = await readFile(join(webRoot, 'lib', name + '.ts'), 'utf8');
    const source = ts.createSourceFile(name + '.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const replacements = [];
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue;
      const target = node.moduleSpecifier.text;
      if (name !== 'seo' || target !== './brand') throw new Error(`Unexpected SEO runtime import: ${target}`);
      const imported = await compile('brand');
      replacements.push([node.moduleSpecifier.getStart(source), node.moduleSpecifier.end, JSON.stringify(imported)]);
    }
    for (const [start, end, replacement] of replacements.sort((a, b) => b[0] - a[0])) code = code.slice(0, start) + replacement + code.slice(end);
    const output = ts.transpileModule(code, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
    const compiled = ts.createSourceFile(name + '.mjs', output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const inspect = node => {
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) throw new Error('SEO modules cannot re-export a runtime module.');
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) throw new Error('SEO modules cannot load runtime dependencies.');
      ts.forEachChild(node, inspect);
    };
    inspect(compiled);
    const url = 'data:text/javascript;base64,' + Buffer.from(output).toString('base64');
    modules.set(name, url);
    return url;
  }
  return import(await compile('seo'));
}

export function renderSeoHead(page) {
  const canonical = safeUrl(page.canonical);
  const image = safeUrl(page.image);
  if (!canonical) throw new Error('SEO head requires a safe canonical URL.');
  const robots = page.indexable ? 'index,follow,max-image-preview:large' : 'noindex,follow';
  return [
    `<title>${escapeHtml(page.title)}</title>`,
    `<meta name="description" content="${escapeHtml(page.description)}">`,
    `<meta name="robots" content="${robots}">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:locale" content="ru_RU">`,
    `<meta property="og:site_name" content="${escapeHtml(page.siteName)}">`,
    `<meta property="og:title" content="${escapeHtml(page.title)}">`,
    `<meta property="og:description" content="${escapeHtml(page.description)}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    ...(image ? [`<meta property="og:image" content="${escapeHtml(image)}">`, `<meta property="og:image:alt" content="${escapeHtml(page.siteName)} — карта пеших маршрутов России">`] : []),
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(page.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(page.description)}">`,
    ...(image ? [`<meta name="twitter:image" content="${escapeHtml(image)}">`] : []),
    ...(page.structuredData || []).map(item => `<script type="application/ld+json">${jsonLd(item)}</script>`),
  ].join('\n');
}

function anchor(item) {
  const url = safeUrl(item.url);
  return url ? `<a href="${escapeHtml(url)}">${escapeHtml(item.name)}</a>` : escapeHtml(item.name);
}

/** Visible first-response content is replaced by the equivalent interactive page. */
export function renderStaticContent(page, {regions: _regions = [], trails: _trails = [], base = '/'} = {}) {
  if (!/^\/(?:[a-z0-9-]+\/)*$/i.test(base)) throw new Error('Invalid static content base path.');
  const crumbs = page.breadcrumbs?.length ? `<nav class="seo-breadcrumbs" aria-label="Хлебные крошки"><ol>${page.breadcrumbs.map(item => `<li>${anchor(item)}</li>`).join('')}</ol></nav>` : '';
  const facts = page.facts?.length ? `<dl class="facts-grid">${page.facts.map(fact => `<div><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}${fact.note ? `<p>${escapeHtml(fact.note)}</p>` : ''}</dd></div>`).join('')}</dl>` : '';
  const limitations = page.limitations?.length ? `<section><h2>Что нужно уточнить перед выходом</h2><ul>${page.limitations.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul></section>` : '';
  const sources = page.sources?.filter(source => safeUrl(source.url)) || [];
  const references = sources.length ? `<section><h2>Источники сведений</h2><ul>${sources.map(source => `<li><a href="${escapeHtml(safeUrl(source.url))}" rel="noopener noreferrer">${escapeHtml(source.name)}</a>${source.checkedAt ? ` · источник просмотрен ${escapeHtml(source.checkedAt)}` : ''}</li>`).join('')}</ul></section>` : '';
  const label = page.kind === 'home' ? 'Каталог и направления' : page.kind === 'route' ? 'Продолжить выбор' : 'Маршруты';
  const related = page.links?.length ? `<section><h2>${label}</h2><nav aria-label="${label}"><ul>${page.links.map(item => `<li>${anchor(item)}${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}</li>`).join('')}</ul></nav></section>` : '';
  const hasMap = ['home', 'region', 'route'].includes(page.kind);
  const header = `<header class="pages-static-header"><a class="brand" href="${base}" aria-label="${escapeHtml(page.siteName)} — на главную"><img src="${base}brand-mark.svg" width="40" height="40" alt=""><span>${escapeHtml(page.siteName.toLocaleLowerCase('ru'))}</span></a><a class="button secondary small" href="${base}routes/">Каталог маршрутов</a></header>`;
  // Reserve the existing map geometry before its lazy chunk arrives. The same
  // source description stays below it both before and after the client mounts.
  // The mobile sheet is collapsed until React loads. Keep the sole document H1
  // in the always-visible article, not inside the sheet's hidden content.
  const peekLabel = page.kind === 'route' ? 'Маршрут' : page.kind === 'region' ? 'Направление' : 'Карта маршрутов';
  const peek = `<div class="sheet-handle" aria-hidden="true"><span></span></div><a class="sheet-peek-summary" href="#static-description"><span class="sheet-peek-copy"><small>${peekLabel}</small><strong>${escapeHtml(page.heading)}</strong><span>Перейти к описанию</span></span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></a>`;
  const map = hasMap ? `<section class="explore-layout sheet-closed" data-sheet-state="closed" aria-label="Выбор маршрута"><aside class="explore-panel collapsed pages-static-panel">${peek}<div class="explore-panel-content"><p class="eyebrow">${escapeHtml(page.siteName)}</p><p class="heading-4">${escapeHtml(page.heading)}</p><p class="panel-intro body-6">${escapeHtml(page.description)}</p><a class="text-link" href="#static-description">Читать описание</a></div></aside><div class="atlas-wrap pages-static-map"><div><p>Карта маршрутов России</p><a class="button secondary" href="#static-description">Перейти к описанию</a></div></div></section>` : '';
  return `<div class="pages-static-root">${header}<main id="main">${map}<article id="static-description" class="region-article seo-article">${crumbs}<p class="eyebrow">${escapeHtml(page.siteName)}</p><h1 class="heading-4">${escapeHtml(page.heading)}</h1>${(page.paragraphs || []).map(value => `<p>${escapeHtml(value)}</p>`).join('')}${facts}${limitations}${references}${related}</article></main></div>`;
}

export function renderSitemap(pages) {
  const urls = [...new Set(pages.filter(page => page.indexable).map(page => safeUrl(page.canonical)).filter(Boolean))].sort();
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map(url => `  <url><loc>${escapeHtml(url)}</loc></url>`).join('\n') + '\n</urlset>\n';
}

export function renderRobots({siteUrl, base = '/', publicIndexing}) {
  const safe = safeUrl(siteUrl);
  if (!safe) throw new Error('robots.txt requires an absolute HTTP(S) site URL.');
  if (!/^\/(?:[a-z0-9-]+\/)*$/i.test(base)) throw new Error('Invalid robots.txt base path.');
  const root = new URL(safe);
  root.search = ''; root.hash = '';
  if (root.pathname === '/' && base !== '/') root.pathname = base;
  root.pathname = root.pathname.replace(/\/+$/, '') + '/';
  const comment = base !== '/' ? '# A robots.txt in a project subdirectory is informational. Crawlers use /robots.txt at the host root.\n' : '';
  if (!publicIndexing) return comment + 'User-agent: *\nDisallow: /\n';
  return comment + 'User-agent: *\nAllow: /\nSitemap: ' + new URL('sitemap.xml', root).href + '\n';
}
