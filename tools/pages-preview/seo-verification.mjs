import assert from 'node:assert/strict';

const decode = value => value.replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos|#39);/gi, (_all, numeric, named) => numeric
  ? String.fromCodePoint(numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric))
  : ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",'#39':"'"}[named.toLowerCase()]));

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)]
    .map(([, name, _quote, value]) => [name.toLowerCase(), decode(value)]));
}

export function assertPageSeo(html, page, report) {
  assert.ok(page.seo && typeof page.seo.indexable === 'boolean', `Missing indexing policy: ${page.path}`);
  const metas = [...html.matchAll(/<meta\s[^>]*>/gi)].map(match => attributes(match[0]));
  const meta = key => {
    const values = metas.filter(value => value.name === key || value.property === key);
    assert.equal(values.length, 1, `One ${key} is required: ${page.path}`);
    return values[0].content;
  };
  const canonical = [...html.matchAll(/<link\s[^>]*>/gi)].map(match => attributes(match[0])).filter(value => value.rel === 'canonical');
  assert.equal(canonical.length, 1, `One canonical is required: ${page.path}`);
  const expectedUrl = report.origin + report.base + (page.path === '/' ? '' : page.path.replace(/^\/+|\/+$/g, '') + '/');
  assert.equal(canonical[0].href, expectedUrl, `Canonical must point to this exact page: ${page.path}`);
  assert.equal(canonical[0].href, page.seo.canonical);
  const titles = [...html.matchAll(/<title>(.*?)<\/title>/gs)];
  assert.equal(titles.length, 1);
  assert.equal(decode(titles[0][1]), page.seo.title);
  assert.match(page.seo.title, /Тропиныч/);
  assert.equal(meta('description'), page.seo.description);
  assert.equal(meta('og:title'), page.seo.title);
  assert.equal(meta('og:description'), page.seo.description);
  assert.equal(meta('og:url'), expectedUrl);
  assert.equal(meta('og:site_name'), 'Тропиныч');
  assert.equal(meta('og:image'), report.origin + report.base + 'og-cover.png');
  assert.equal(meta('twitter:title'), page.seo.title);
  const directives = meta('robots').split(/\s*,\s*/);
  assert.equal(directives.includes('noindex'), !page.seo.indexable, `Wrong index directive: ${page.path}`);
  assert.equal(directives.includes('index'), page.seo.indexable);
  if (!report.indexing.enabled) assert.equal(page.seo.indexable, false, 'Private exports must remain noindex');
  assert.equal([...html.matchAll(/<h1(?:\s|>)/gi)].length, 1, `Initial HTML must have one meaningful H1: ${page.path}`);
  assert.ok(!html.includes('tropinych-static-placeholder') && !html.includes('content="pending"'));
  const schemas = [...html.matchAll(/<script\s+type="application\/ld\+json">(.*?)<\/script>/gs)].map(match => JSON.parse(match[1]));
  assert.ok(schemas.some(value => value.url === expectedUrl), `Structured data must describe this page: ${page.path}`);
  if (page.seo.indexable) {
    assert.ok(page.seo.description.length >= 40);
    assert.ok(/<article\b/.test(html));
    assert.ok(/<a\s[^>]*href=/.test(html), `Indexable content must have navigable links: ${page.path}`);
  }
  return {indexable:page.seo.indexable, canonical:expectedUrl};
}

export function assertSitemap(xml, pages, report) {
  assert.match(xml, /<urlset\s+xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const actual = [...xml.matchAll(/<loc>(.*?)<\/loc>/gs)].map(match => decode(match[1]));
  const expected = pages.filter(page => page.seo.indexable).map(page => page.seo.canonical).sort();
  assert.equal(new Set(actual).size, actual.length, 'Sitemap must not contain duplicates');
  assert.deepEqual(actual.slice().sort(), expected, 'Sitemap must contain exactly the canonical indexable pages');
  assert.equal(actual.length, report.indexing.eligiblePages);
  for (const value of actual) {
    const url = new URL(value);
    assert.equal(url.origin, report.origin);
    assert.ok(url.pathname.startsWith(report.base));
    assert.equal(url.search + url.hash, '');
  }
  return actual.length;
}
