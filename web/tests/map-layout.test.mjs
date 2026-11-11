import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const postcss = createRequire(require.resolve('@tailwindcss/postcss'))('postcss');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../app/globals.css');
const custom = read('../app/custom-map.css');

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

test('the custom map surface remains full size in either stylesheet order', () => {
  for (const sheets of [[app, custom], [custom, app]]) {
    const actual = containerStyle(sheets, ['atlas-canvas', 'tropnik-map-surface']);
    assert.equal(actual.position, 'absolute');
    assert.equal(actual.inset, '0');
    assert.equal(actual.width, '100%');
    assert.equal(actual.height, '100%');
    assert.equal(actual.overflow, 'hidden');
  }
});
