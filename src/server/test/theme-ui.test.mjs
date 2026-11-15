import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { defaultPreset, defaultFilter, defaultTreemap } from '../store.mjs';
const require = createRequire(new URL('../../treemap/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const { build } = require('esbuild');
const bundle = await build({ entryPoints: [new URL('../public/app.js', import.meta.url).pathname], bundle: true, format: 'esm', write: false });
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/themes.css', import.meta.url), 'utf8');

async function page(t, { saved, blocked = false } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost/#treemap', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, doc = window.document;
  const style = doc.createElement('style'); style.textContent = css; doc.head.append(style);
  if (saved) window.localStorage.setItem('code-view.theme', saved);
  if (blocked) Object.defineProperty(window, 'localStorage', { get() { throw new window.DOMException('Blocked', 'SecurityError'); } });
  // Restore the saved palette before the app starts, as the head script does in a browser.
  window.eval(doc.querySelector('head script').textContent);
  const initialTheme = doc.documentElement.dataset.theme;
  const requests = [];
  const state = { inspections: [{ id: 'repo', name: 'Repo', hasResults: true }], presets: [{ id: 'preset', ...defaultPreset() }], filters: [{id:'filter',...defaultFilter()}], treemaps: [{id:'treemap',...defaultTreemap()}], selection: { inspection: 'repo', preset: 'preset' } };
  window.fetch = async (path, options) => {
    requests.push({ path, options });
    return { ok: true, json: async () => path === '/api/state' ? structuredClone(state) : { metrics: [], treeMapHtml: '<p>Map</p>', treeMapWarningsHtml: '' } };
  };
  await window.eval(`(async()=>{${bundle.outputFiles[0].text}\n})()`);
  await new Promise(resolve => setImmediate(resolve));
  const select = doc.querySelector('#theme-select');
  return { window, doc, select, requests, initialTheme, change(value) {
    select.value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  } };
}

test('theme selection persists locally and restores before app startup without replacing forms or the map', async t => {
  const first = await page(t);
  assert.equal(first.select.value, 'light');
  assert.deepEqual([...first.select.options].map(option => option.textContent), ['Light', 'Dark', 'Nord', 'Dracula', 'Solarized']);
  const frame = first.doc.querySelector('#map iframe');
  const messages = [];
  frame.contentWindow.postMessage = message => messages.push(message);
  for (const theme of ['dark', 'nord', 'dracula', 'solarized']) {
    first.change(theme);
    assert.equal(first.doc.documentElement.dataset.theme, theme);
    assert.equal(first.window.localStorage.getItem('code-view.theme'), theme);
    assert.equal(first.doc.querySelector('#map iframe'), frame);
    assert.match(messages.at(-1).styles, /--cv-bg:/);
  }
  assert.ok(first.requests.every(request => request.options.method === 'GET'));
  const restored = await page(t, { saved: first.window.localStorage.getItem('code-view.theme') });
  assert.equal(restored.initialTheme, 'solarized');
  assert.equal(restored.select.value, 'solarized');
  assert.match(restored.doc.querySelector('#map iframe').srcdoc, /--cv-bg:\s*#fdf6e3/);
  restored.window.history.replaceState(null, '', '#inspections');
  restored.window.dispatchEvent(new restored.window.Event('hashchange'));
  const form = restored.doc.querySelector('#inspection-form');
  form.querySelector('[name="name"]').value = 'Unsaved edit';
  restored.change('dark');
  assert.equal(restored.doc.querySelector('#inspection-form'), form);
  assert.equal(form.querySelector('[name="name"]').value, 'Unsaved edit');
});

test('invalid or unavailable localStorage falls back to Light and still permits theme changes', async t => {
  const invalid = await page(t, { saved: 'unknown' });
  assert.equal(invalid.select.value, 'light');
  assert.equal(invalid.doc.documentElement.dataset.theme, 'light');
  const blocked = await page(t, { blocked: true });
  assert.equal(blocked.select.value, 'light');
  assert.doesNotThrow(() => blocked.change('dracula'));
  assert.equal(blocked.doc.documentElement.dataset.theme, 'dracula');
});

test('theme storage changes synchronize the selector and palette across tabs', async t => {
  const p = await page(t);
  p.window.dispatchEvent(new p.window.StorageEvent('storage', { key: 'code-view.theme', newValue: 'nord' }));
  assert.equal(p.select.value, 'nord');
  assert.equal(p.doc.documentElement.dataset.theme, 'nord');
  p.window.dispatchEvent(new p.window.StorageEvent('storage', { key: null, newValue: null }));
  assert.equal(p.select.value, 'light');
});
