import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const postcss = createRequire(require.resolve('@tailwindcss/postcss'))('postcss');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../app/globals.css');
const vendors = {
  'maplibregl-map': read('../node_modules/maplibre-gl/dist/maplibre-gl.css'),
  'leaflet-container': read('../node_modules/leaflet/dist/leaflet.css'),
};

// Evaluate the actual class-only container rules, including descendant/child
// selectors and specificity. This deliberately does not claim to be a browser.
function containerStyle(sheets, classes) {
  const ancestors = [new Set(classes), new Set(['atlas-wrap']), new Set(['explore-layout'])];
  const properties = new Map();
  const matches = selector => {
    if (!/^(?:\.[\w-]+(?:\.[\w-]+)*)(?:(?:\s*>\s*|\s+)(?:\.[\w-]+(?:\.[\w-]+)*))*$/.test(selector)) return false;
    const tokens = selector.trim().split(/\s*(>)\s*|\s+/).filter(Boolean).reverse();
    let at = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '>') {at++; continue;}
      const required = tokens[i].split('.').filter(Boolean);
      if (i > 0 && tokens[i - 1] !== '>') {at++; while (at < ancestors.length && !required.every(name => ancestors[at].has(name))) at++;}
      if (at >= ancestors.length || !required.every(name => ancestors[at].has(name))) return false;
    }
    return true;
  };
  for (const sheet of sheets) postcss.parse(sheet).walkRules(rule => {
    // Container geometry is unconditional; viewport rules style its parent only.
    if (rule.parent.type !== 'root') return;
    for (const selector of rule.selectors) {
      if (!matches(selector)) continue;
      const specificity = (selector.match(/\.[\w-]+/g) || []).length;
      rule.walkDecls(declaration => {
        const candidate = {value: declaration.value, rank: (declaration.important ? 1000 : 0) + specificity};
        if (candidate.rank >= (properties.get(declaration.prop)?.rank ?? -1)) properties.set(declaration.prop, candidate);
      });
    }
  });
  return Object.fromEntries([...properties].map(([name, entry]) => [name, entry.value]));
}

test('real vendor stylesheet order cannot collapse the atlas container', () => {
  for (const [className, css] of Object.entries(vendors)) for (const sheets of [[app, css], [css, app]]) {
    const actual = containerStyle(sheets, ['atlas-canvas', className]);
    assert.equal(actual.position, 'absolute', `${className}: vendor CSS must not move the empty container into normal flow`);
    assert.equal(actual.inset, '0');
    assert.equal(actual.width, '100%');
    assert.equal(actual.height, '100%');
  }
  const broken = containerStyle(['.atlas-canvas{position:absolute;inset:0}', vendors['maplibregl-map']], ['atlas-canvas', 'maplibregl-map']);
  assert.equal(broken.position, 'relative', 'the extracted vendor CSS must reproduce the original cascade conflict');
  assert.equal(broken.height, undefined, 'an auto-height container with only absolute children can collapse to zero');
});

