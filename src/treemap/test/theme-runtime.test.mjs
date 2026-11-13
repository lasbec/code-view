import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountTreeMap } from '../src/runtime.mjs';
import { colorFor } from '../src/data.mjs';

function mount(t, legend, themed = true, extra = {}) {
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
  const model = { tree: { name: '/', children: [file] }, legend, areaMetric: 'lines', ...extra };
  dom.window.eval(`(${mountTreeMap.toString()})(document.querySelector('#map'), ${JSON.stringify(model)})`);
  return { root: host.shadowRoot, model, dom, host };
}

test('compact heat controls recolor tiles and borders, validate thresholds and reset to automatic without losing zoom', t => {
  for (const themed of [true, false]) {
    const {root,dom,host}=mount(t,{min:0,yellowFrom:30,redFrom:70,max:100},themed,{heat:{max:100},observedMax:120});
    const form=root.querySelector('.heat-controls'),field=key=>form.elements.namedItem(key);
    assert.equal(root.querySelector('.legend').nextElementSibling,form);
    assert.equal(form.querySelectorAll('input').length,4);
    assert.equal(field('max').value,'100');assert.equal(field('min').value,'');
    root.querySelector('.file-frame').click();
    const nav=root.querySelector('nav').textContent;
    let message;host.addEventListener('code-view-heat',event=>{message=event.detail;});
    field('yellowFrom').value='50';field('redFrom').value='80';
    form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    assert.equal(message.heat.yellowFrom,50);
    const tile=[...root.querySelectorAll('.tile')].find(n=>n.textContent.startsWith('f4 '));
    assert.equal(tile.style.background,themed?'var(--cv-heat-yellow,rgb(255,215,0))':'rgb(255, 215, 0)');
    assert.equal(root.querySelector('nav').textContent,nav);
    assert.match(root.querySelector('.labels').textContent,/Gelb ab: 50/);
    message=null;field('redFrom').value='40';
    const before=root.querySelector('.bar').style.background;
    form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    assert.equal(message,null);assert.ok(form.querySelector('.error'));
    assert.equal(root.querySelector('.bar').style.background,before);
    [...form.querySelectorAll('button')].find(b=>b.textContent==='Auto').click();
    assert.deepEqual(Object.keys(message.heat),[]);
    assert.equal(field('max').value,'');assert.equal(field('max').placeholder,'120');
    assert.match(root.querySelector('.labels').textContent,/Violett: 120/);
    assert.equal(root.querySelector('nav').textContent,nav);
    const neutral=[...root.querySelectorAll('.tile')].find(n=>n.textContent.startsWith('f8 '));
    assert.match(neutral.style.background,/--cv-heat-neutral/);
  }
});

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

test('main author mode colors file and function tiles, renders categorical legend and returns to heat',t=>{
  const author={id:'alice',name:'Alice',color:'#aabbcc'};
  const children=[{id:'f',path:'a.ts',kind:'function',name:'f',area:10,heat:50,mainAuthor:author}];
  const tree={name:'/',children:[{id:'a.ts',path:'a.ts',kind:'file',name:'a.ts',area:10,heat:50,mainAuthor:author,children}]};
  const {root,dom}=mount(t,{min:0,yellowFrom:30,redFrom:70,max:100},true,{tree,authors:[author]});
  const select=root.querySelector('select[aria-label="Color by"]');assert.ok(select);
  select.value='author';select.dispatchEvent(new dom.window.Event('change'));
  assert.match(root.querySelector('.legend').textContent,/Alice/);assert.equal(root.querySelector('.heat-controls').hidden,true);
  assert.equal(root.querySelector('.tile:not(.file-frame)').style.background,'rgb(170, 187, 204)');
  select.value='score';select.dispatchEvent(new dom.window.Event('change'));assert.equal(root.querySelector('.heat-controls').hidden,false);
});
