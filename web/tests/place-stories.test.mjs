import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {placeFacts, factsForPlace} from '../lib/facts.ts';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const stories = read('../components/PlaceStories.tsx');
const releaseCss = read('../app/map-ui-release.css');
const layout = read('../app/layout.tsx');
const terms = read('../app/terms/page.tsx');
const review = JSON.parse(read('../../docs/verification/place-stories-2026-11-13.json'));
const initialRegions = read('../lib/content.ts').match(/const initialRegions: Region\[\] = \[([\s\S]*?)\n\];/)[1];
const directionIds = [
  ...[...initialRegions.matchAll(/\bid: '([^']+)'/g)].map(match => match[1]),
  ...JSON.parse(read('../lib/editorial-regions.generated.json')).regions.map(region => region.id),
];
const normalized = text => text.normalize('NFKC').toLocaleLowerCase('ru').replace(/[\p{P}\p{Z}\s]+/gu, ' ').trim();
function safeHttps(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', `link must use HTTPS: ${value}`);
  assert.equal(url.username + url.password + url.port, '', `link must not contain credentials or a custom port: ${value}`);
  return url;
}

test('every catalogue direction has at least two distinct Russian editorial stories', () => {
  const ids = placeFacts.map(fact => fact.id);
  assert.ok(ids.length >= 42, 'the original 24 and the 18 additional stories must remain available');
  assert.equal(new Set(ids).size, ids.length, 'story ids must stay unique');
  assert.equal(new Set(placeFacts.map(fact => normalized(fact.title))).size, ids.length, 'titles must not duplicate other stories');
  assert.equal(new Set(placeFacts.map(fact => normalized(fact.body))).size, ids.length, 'bodies must not repeat another story with punctuation changes');
  const counts = Object.groupBy(placeFacts, fact => fact.regionId);
  assert.deepEqual(Object.keys(counts).sort(), [...directionIds].sort(), 'stories must cover the actual catalogue directions without unknown region ids');
  for (const region of directionIds) assert.ok(counts[region].length >= 2, `${region} needs navigation in both directions`);
  for (const region of ['altai', 'krasnodar', 'karelia', 'krym', 'baikal', 'kamchatka']) assert.ok(counts[region].length >= 4, `${region} must retain its original four stories`);
  for (const fact of placeFacts) {
    const source = safeHttps(fact.sourceUrl);
    assert.ok(source.hostname.endsWith('.ru'), `story source must be Russian-language first-party material: ${source.href}`);
    assert.doesNotMatch(source.pathname, /(^|\/)en(\/|$)/i, `English route is forbidden: ${source.href}`);
    assert.match(fact.title + fact.body, /[\p{Script=Cyrillic}]/u);
    assert.match(fact.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(fact.source.trim().length > 0);
  }
});

test('new facts remain bound to the dated primary-source review and their intended region', () => {
  const added = placeFacts.filter(fact => review.coverage.addedDirectionIds.includes(fact.regionId));
  assert.equal(review.coverage.addedDirectionIds.length, 9);
  assert.equal(review.facts.length, 18);
  assert.equal(added.length, review.facts.length, 'each additional story needs a reviewed evidence record');
  assert.equal(new Set(review.facts.map(fact => fact.id)).size, review.facts.length);
  for (const entry of review.facts) {
    const fact = added.find(fact => fact.id === entry.id);
    assert.ok(fact, `missing reviewed fact ${entry.id}`);
    assert.equal(fact.regionId, entry.regionId);
    assert.equal(fact.source, entry.source);
    assert.equal(fact.sourceUrl, entry.sourceUrl);
    assert.equal(fact.checkedAt, entry.checkedAt);
    assert.equal(entry.checkedAt, review.checkedAt);
    assert.ok(entry.evidence.length > 30, `${entry.id} needs a specific claim location and scope`);
    const imageName = decodeURIComponent(new URL(fact.imageUrl).pathname.split('/file/')[1]);
    assert.equal(imageName, entry.photoFileName, `${entry.id} must use its reviewed illustration`);
    assert.equal(fact.routeIds, undefined, 'regional facts must not invent verified trail associations');
  }
});

test('every photograph has a matching source, author and free licence link', () => {
  const photographs = new Map(review.photographs.map(photo => [photo.fileName, photo]));
  assert.equal(photographs.size, review.photographs.length, 'the photo review must contain unique files');
  assert.equal(new Set(placeFacts.map(fact => fact.imageUrl)).size, photographs.size, 'every used photo must have a review and every reviewed photo must be used');
  for (const fact of placeFacts) {
    const image = safeHttps(fact.imageUrl);
    assert.equal(image.hostname, 'commons.wikimedia.org');
    assert.ok(image.pathname.startsWith('/wiki/Special:Redirect/file/'));
    const fileName = decodeURIComponent(image.pathname.split('/file/')[1]);
    const photo = photographs.get(fileName);
    assert.ok(photo, `no photo provenance for ${fact.id}`);
    const source = safeHttps(fact.imageSourceUrl);
    assert.equal(source.hostname, 'commons.wikimedia.org');
    assert.ok(source.pathname.startsWith('/wiki/File:'));
    assert.equal(decodeURIComponent(source.pathname.slice('/wiki/File:'.length)).replaceAll('_', ' '), fileName.replaceAll('_', ' '), 'the credit link must identify the displayed photograph');
    const licence = safeHttps(fact.imageLicenseUrl);
    assert.equal(licence.hostname, 'creativecommons.org');
    assert.match(licence.pathname, /^\/licenses\/(by|by-sa)\/[234]\.0\/(igo\/)?deed\.en$/);
    assert.equal(fact.imageSourceUrl, photo.sourceUrl);
    assert.equal(fact.imageCredit, photo.credit);
    assert.ok(fact.imageCredit.includes(photo.author), 'the visible credit must name the verified author');
    assert.equal(fact.imageLicense, photo.license);
    assert.equal(fact.imageLicenseUrl, photo.licenseUrl);
    assert.equal(photo.checkedAt, review.checkedAt);
    assert.ok(fact.imageAlt.trim().length > 0);
  }
});

test('direction selection returns local stories and preserves the existing trail-specific selection', () => {
  for (const region of directionIds) {
    const local = factsForPlace(region);
    assert.ok(local.length >= 2, `${region} must not render an empty story card`);
    assert.ok(local.every(fact => fact.regionId === region));
    assert.deepEqual(factsForPlace(region, 'unlinked-trail'), local);
  }
  const trailStories = factsForPlace('krasnodar', 'kavkaz-16a');
  assert.ok(trailStories.length > 1);
  assert.ok(trailStories.every(fact => fact.routeIds?.includes('kavkaz-16a')));
  assert.deepEqual(factsForPlace('unknown-region'), []);
  assert.deepEqual(factsForPlace(), placeFacts);
});

test('the terms appendix renders each photo credit with its own source and licence once', () => {
  const require = createRequire(import.meta.url);
  const compiledModule = {exports: {}};
  const compiled = ts.transpileModule(terms, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText;
  new Function('require', 'module', 'exports', compiled)(specifier => {
    if (specifier === '@/lib/facts') return {placeFacts};
    if (specifier === '@/components/ContentPage') return {ContentPage: ({children}) => createElement('main', null, children)};
    return require(specifier);
  }, compiledModule, compiledModule.exports);
  const html = renderToStaticMarkup(createElement(compiledModule.exports.default));
  assert.match(html, /<details id="story-references">/);
  const rows = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match => match[1]);
  assert.equal(rows.length, placeFacts.length + review.photographs.length);
  for (const photo of review.photographs) {
    const matching = rows.filter(row => row.includes(`href="${photo.sourceUrl}"`));
    assert.equal(matching.length, 1, `${photo.fileName} must have one public credit`);
    assert.ok(matching[0].includes(photo.credit));
    assert.ok(matching[0].includes(`href="${photo.licenseUrl}"`));
    assert.ok(matching[0].includes(photo.license));
    assert.match(matching[0], /target="_blank" rel="noreferrer"/);
  }
});

test('story navigation works in both directions on buttons, keyboard and swipe', () => {
  assert.match(stories, /aria-label="Предыдущая история"/);
  assert.match(stories, /aria-label="Следующая история"/);
  assert.match(stories, /event\.key==='ArrowLeft'/);
  assert.match(stories, /event\.key==='ArrowRight'/);
  assert.match(stories, /Math\.abs\(dx\)>=44/);
  assert.doesNotMatch(stories, /href=\{fact\.sourceUrl\}/, 'external source sites must not be exposed in the story card');
  assert.match(stories, /<img key=\{fact\.imageUrl\}/, 'stories must use a native image element');
  assert.match(stories, /IntersectionObserver/, 'off-screen stories must pause background work');
  assert.match(stories, /disabled=\{reduced\}/, 'system reduced-motion must disable autoplay');
  assert.doesNotMatch(stories, /setReduced\(false\)/, 'the UI must not override the operating-system motion preference');
});

test('map UI guardrails precede the focused sheet and detail layers', () => {
  assert.match(releaseCss, /--map-control-size:44px/);
  assert.match(releaseCss, /\.map-controls button[\s\S]*width:var\(--map-control-size\)[\s\S]*height:var\(--map-control-size\)/);
  assert.match(releaseCss, /\.map-style-switch button[\s\S]*height:var\(--map-control-size\)/);
  assert.match(releaseCss, /env\(safe-area-inset-right/);
  assert.match(releaseCss, /@media\(max-width:700px\)/);
  assert.match(releaseCss, /@media\(max-height:620px\) and \(orientation:landscape\)/);
  const imports = [...layout.matchAll(/import "\.\/(.+?\.css)";/g)].map(match => match[1]);
  const releaseIndex = imports.indexOf('map-ui-release.css');
  assert.ok(releaseIndex > imports.indexOf('interface-refresh.css'), 'map release overrides must stay after every legacy map stylesheet');
  assert.deepEqual(imports.slice(-5), ['final-polish.css', 'map-sheet.css', 'map-detail.css', 'map-direction-marker.css', 'custom-map.css'], 'focused gesture, detail and custom map rules must follow generic cross-platform defaults');
  assert.ok(imports.indexOf('final-polish.css') > releaseIndex, 'generic guardrails must not replace map-specific release geometry');
});
