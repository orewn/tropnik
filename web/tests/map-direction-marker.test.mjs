import test from 'node:test';
import assert from 'node:assert/strict';
import {createDirectionMarker} from '../lib/map-direction-marker.ts';
import {groupMapDirections, updateDirectionButtons} from '../lib/map-direction-layout.ts';

// Minimal element tree for factory/update integration. Replacing textContent
// removes descendants as in the DOM, so accidental replacement of the emblem
// by a route count is observable. This is not a rendering or hit-area test.
function documentFixture() {
  class Element {
    children = [];
    attributes = new Map();
    dataset = {};
    className = '';
    hidden = false;
    ownText = '';
    constructor(localName, namespaceURI) {
      this.localName = localName;
      this.namespaceURI = namespaceURI;
      this.ownerDocument = ownerDocument;
      this.classList = {toggle: (name, enabled) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
      }};
    }
    appendChild(node) {
      if (node.parentElement) {
        const siblings = node.parentElement.children;
        siblings.splice(siblings.indexOf(node), 1);
      }
      node.parentElement = this;
      this.children.push(node);
      return node;
    }
    append(...nodes) {for (const node of nodes) this.appendChild(node);}
    setAttribute(name, value) {this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value);}
    getAttribute(name) {return this.attributes.get(name) ?? null;}
    removeAttribute(name) {this.attributes.delete(name);}
    set textContent(value) {for (const child of this.children) child.parentElement = null; this.children = []; this.ownText = String(value);}
    get textContent() {return this.ownText + this.children.map(child => child.textContent).join('');}
    querySelector(selector) {
      const match = node => selector.startsWith('.') ? node.className.split(/\s+/).includes(selector.slice(1)) : node.localName === selector;
      for (const child of this.children) {if (match(child)) return child; const nested = child.querySelector(selector); if (nested) return nested;}
      return null;
    }
    focus() {this.ownerDocument.activeElement = this;}
  }
  const ownerDocument = {
    activeElement: null,
    createElement: name => new Element(name, 'http://www.w3.org/1999/xhtml'),
    createElementNS: (namespace, name) => new Element(name, namespace),
  };
  return ownerDocument;
}

test('a direction is one named native button with a decorative non-focusable emblem', () => {
  const doc = documentFixture();
  const button = createDirectionMarker({id: 'altai', name: 'Алтай'}, doc);
  assert.equal(button.localName, 'button');
  assert.equal(button.type, 'button', 'map selection must never submit an enclosing form');
  assert.equal(button.dataset.regionId, 'altai');
  assert.equal(button.getAttribute('aria-label'), 'Открыть Алтай');
  assert.equal(button.querySelector('.region-marker-label').textContent, 'Алтай');
  const emblem = button.querySelector('.region-marker-emblem');
  const count = button.querySelector('.region-marker-count');
  const svg = emblem.querySelector('svg');
  assert.equal(emblem.getAttribute('aria-hidden'), 'true');
  assert.equal(count.getAttribute('aria-hidden'), 'true');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.equal(svg.getAttribute('focusable'), 'false');
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.ok(svg.querySelector('path'), 'the region retains its distinct drawn emblem');
  assert.equal(count.parentElement, emblem);
  assert.notEqual(count, svg);
  assert.equal(button.querySelector('.region-marker-dot'), null, 'the old trail-like dot must not return');
});

test('overview counts, group expansion, and detail selection preserve the original region artwork', () => {
  const doc = documentFixture();
  const directions = [{id: 'a', name: 'Алтай', center: [86, 51]}, {id: 'b', name: 'Саяны', center: [94, 52]}];
  const buttons = new Map(directions.map(direction => [direction.id, createDirectionMarker(direction, doc)]));
  const artwork = new Map([...buttons].map(([id, button]) => [id, button.querySelector('svg')]));
  const paths = new Map([...artwork].map(([id, svg]) => [id, [...svg.children]]));
  const counts = new Map([['a', 17], ['b', 8]]);
  const expanded = groupMapDirections(directions, ([lng, lat]) => ({x: lng * 200, y: lat * 200}));
  updateDirectionButtons(buttons, expanded, counts, true);
  assert.equal(buttons.get('a').querySelector('.region-marker-count').textContent, '17');
  assert.equal(buttons.get('a').getAttribute('aria-label'), 'Открыть Алтай, маршрутов в каталоге: 17');
  const grouped = groupMapDirections(directions, () => ({x: 0, y: 0}));
  updateDirectionButtons(buttons, grouped, counts, true);
  const anchor = buttons.get(grouped[0].anchor.id);
  assert.equal(anchor.querySelector('.region-marker-count').textContent, '2');
  assert.equal(anchor.querySelector('.region-marker-label').textContent, '2 направления');
  assert.match(anchor.getAttribute('aria-label'), /^Приблизить 2 направления:/);
  updateDirectionButtons(buttons, expanded, counts, false, 'a');
  assert.equal(buttons.get('a').getAttribute('aria-label'), 'Открыть Алтай');
  for (const [id, button] of buttons) {
    assert.equal(button.hidden, false);
    assert.equal(button.querySelector('.region-marker-count').textContent, '');
    assert.equal(button.querySelector('svg'), artwork.get(id), 'count changes must not replace the emblem');
    assert.deepEqual(button.querySelector('svg').children, paths.get(id), 'drawn paths survive grouping and expansion');
  }
});
