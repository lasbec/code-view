import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountTreeMap } from '../src/runtime.mjs';
import { colorFor } from '../src/data.mjs';

function mount(t, legend, themed = true) {
  const dom = new JSDOM('<div id="map"></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const host = dom.window.document.querySelector('#map');
  if (themed) host.style.setProperty('--cv-heat-green', '#a3be8c');
  const nodes = [-10, 0, 15, 30, 50, 70, 100, 110, null].map((heat, i) => ({
    kind: 'function', name: `f${i}`, path: `f${i}`, id: `f${i}`, area: 10,
    heat, color: heat === null ? '#c9d0d8' : colorFor(heat, legend),
  }));
  const file = { kind: 'file', name: 'file', path: 'file', id: 'file', area: 90,
    heat: 50, color: colorFor(50, legend), children: nodes };
  const model = { tree: { name: '/', children: [file] }, legend, areaMetric: 'lines' };
  dom.window.eval(`(${mountTreeMap.toString()})(document.querySelector('#map'), ${JSON.stringify(model)})`);
  return { root: host.shadowRoot, model };
}

test('themed heat uses shared anchors, interpolates scores, clamps outliers and distinguishes unscored tiles', t => {
  const { root, model } = mount(t, { min: 0, yellowFrom: 30, redFrom: 70, max: 100 });
  const tiles = [...root.querySelectorAll('.tile:not(.file-frame)')];
  const backgrounds = tiles.map(tile => tile.style.background);
  for (const [i, color] of [[0, 'green'], [1, 'green'], [3, 'yellow'], [5, 'red'], [6, 'violet'], [7, 'violet'], [8, 'neutral']]) {
    assert.match(backgrounds[i], new RegExp(`^var\\(--cv-heat-${color},`));
  }
  assert.match(backgrounds[2], /^color-mix\(in srgb, var\(--cv-heat-green,.* 50%, var\(--cv-heat-yellow,/);
  assert.match(backgrounds[4], /^color-mix\(in srgb, var\(--cv-heat-yellow,.* 50%, var\(--cv-heat-red,/);
  // jsdom preserves color-mix in the shorthand but cannot expand it into longhands.
  assert.equal(root.querySelector('.file-frame').style.border, `4px solid ${backgrounds[4]}`);
  assert.equal(model.tree.children[0].heat, 50);
  assert.equal(model.tree.children[0].color, 'rgb(240, 130, 23)');
});

test('constant and coincident heat thresholds produce valid colors', t => {
  for (const legend of [
    { min: 0, yellowFrom: 0, redFrom: 0, max: 0 },
    { min: 0, yellowFrom: 0, redFrom: 70, max: 100 },
    { min: 0, yellowFrom: 30, redFrom: 30, max: 100 },
    { min: 0, yellowFrom: 30, redFrom: 100, max: 100 },
  ]) {
    const { root } = mount(t, legend);
    for (const tile of root.querySelectorAll('.tile')) {
      assert.ok(tile.style.background);
      assert.doesNotMatch(tile.style.cssText, /NaN|Infinity/);
    }
    if (legend.min === legend.max) assert.match(root.querySelector('.bar').style.background, /^var\(--cv-heat-green,/);
  }
});

test('standalone snippets preserve the data API colors', t => {
  const legend = { min: 0, yellowFrom: 30, redFrom: 70, max: 100 };
  const { root, model } = mount(t, legend, false);
  assert.equal(root.querySelector('.file-frame').style.borderTopColor, model.tree.children[0].color);
  const tiles = [...root.querySelectorAll('.tile:not(.file-frame)')];
  for (const [i, node] of model.tree.children[0].children.entries()) {
    assert.equal(tiles[i].style.background, node.color === '#c9d0d8' ? 'rgb(201, 208, 216)' : node.color);
  }
});
