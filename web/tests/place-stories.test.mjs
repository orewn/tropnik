import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const facts = read('../lib/facts.ts');
const stories = read('../components/PlaceStories.tsx');
const releaseCss = read('../app/map-ui-release.css');
const layout = read('../app/layout.tsx');

test('place stories use Russian editorial sources and complete photo metadata', () => {
  const ids = [...facts.matchAll(/\bid:'([^']+)'/g)].map(match => match[1]);
  assert.equal(ids.length, 24, 'the release should contain four stories for each of six directions');
  assert.equal(new Set(ids).size, ids.length, 'story ids must stay unique');
  const regions = [...facts.matchAll(/\bregionId:'([^']+)'/g)].map(match => match[1]);
  const counts = Object.groupBy(regions, region => region);
  for (const region of ['altai', 'krasnodar', 'karelia', 'krym', 'baikal', 'kamchatka']) assert.equal(counts[region]?.length, 4, `${region} should have four stories`);
  const sources = [...facts.matchAll(/\bsourceUrl:'([^']+)'/g)].map(match => new URL(match[1]));
  assert.equal(sources.length, ids.length);
  for (const source of sources) {
    assert.ok(source.hostname.endsWith('.ru'), `story source must be Russian-language first-party material: ${source.href}`);
    assert.doesNotMatch(source.pathname, /(^|\/)en(\/|$)/i, `English route is forbidden: ${source.href}`);
  }
  assert.match(facts, /imageCredit:string/);
  assert.match(facts, /imageLicense:string/);
  assert.equal((facts.match(/imageUrl:commons\(/g) || []).length, 7, 'the regional photo set must be explicit and attributed');
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
  assert.deepEqual(imports.slice(-4), ['final-polish.css', 'map-sheet.css', 'map-detail.css', 'map-direction-marker.css'], 'focused gesture, detail and direction rules must follow generic cross-platform defaults');
  assert.ok(imports.indexOf('final-polish.css') > releaseIndex, 'generic guardrails must not replace map-specific release geometry');
});
