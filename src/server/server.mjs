import { createScoreWorker } from '../score-code/worker-client.mjs';
import { editorBundle } from '../score-code/editor-build.mjs';
import { validateDeveloperPreset, defaultDeveloperPreset } from './developers.mjs';
import { validateGraphPreset } from './graph-config.mjs';
import http from 'node:http';
import { inspectDetail } from './details.mjs';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { openStore, validateInspection, validatePreset, validateFilter, validateTreemap, defaultTreemap, check } from './store.mjs';
import { Jobs, usable, fingerprint } from './jobs.mjs';

async function body(req) {
  check(req.headers['content-type']?.split(';')[0] === 'application/json', 'Send application/json.');
  let text = '';
  for await (const chunk of req) { text += chunk; check(Buffer.byteLength(text) <= 262144, 'Request is too large.'); }
  try { return JSON.parse(text); } catch { check(false, 'Invalid JSON.'); }
}
function createRenderer() {
  const worker = createScoreWorker({ entry: new URL('./render-worker.mjs', import.meta.url) });
  return {
    render: (path, preset, detail = false, list = false) => worker.request({ path, preset, detail, list,
      definition: { fields: preset.config.fields }, filter: Object.fromEntries(['include','exclude','since','until'].filter(k => preset.options[k] !== undefined).map(k => [k,preset.options[k]])) }),
    editor: value => worker.request({ ...value, editor: true }), close: () => worker.close(),
  };
}
export async function createApp({ directory = process.env.CODE_VIEW_DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)) } = {}) {
  directory = resolve(directory);
  const store = await openStore(directory), jobs = new Jobs(directory, store), renderer = createRenderer();
  const render = renderer.render;
  const server = http.createServer(async (req, res) => {
    const send = (value, status = 200, type = 'application/json') => { res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(type === 'application/json' ? JSON.stringify(value) : value); };
    try {
      // Reject DNS rebinding and cross-origin browser requests to this local service.
      check(/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? ''), 'Invalid host.');
      if (req.headers.origin) check(['http://127.0.0.1', 'http://localhost'].some(base => req.headers.origin === `${base}:${server.address().port}`), 'Cross-origin requests are not allowed.');
      check(!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] !== 'cross-site', 'Cross-site requests are not allowed.');
      const url = new URL(req.url, 'http://localhost');
      const state = store.get();
      const scoringContext = (score, requireTreemap = false) => {
        if (!score) return undefined;
        const filterId = url.searchParams.get('filter') ?? state.selection.filter;
        const filter = filterId ? state.filters.find(f => f.id === filterId) : state.filters[0];
        const treemapId = url.searchParams.get('treemap') ?? state.selection.treemap;
        const treemap = treemapId ? state.treemaps.find(t => t.id === treemapId) : state.treemaps[0];
        check(filter && (!requireTreemap || treemap), 'Choose a score and filter; the treemap also needs display settings.');
        return { ...score, config: { ...score.config, ...(treemap?.config ?? defaultTreemap().config) }, options: filter.options };
      };
      if (req.method === 'POST' && url.pathname === '/api/score/editor') {
        const value = await body(req);
        check(typeof value.code === 'string' && ['function','file','aggregation'].includes(value.scope), 'Invalid editor request.');
        return send(await renderer.editor(value));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        for (const c of state.inspections) { c.hasResults = usable(jobs.path(c.id)); c.stale = c.hasResults && c.result?.fingerprint !== fingerprint(c); }
        return send({ ...state, job: jobs.current });
      }
      if (req.method === 'POST' && url.pathname === '/api/selection') {
        const value = await body(req);
        await store.update(s => {
          for (const [key, list] of [['inspection', s.inspections], ['preset', s.presets], ['graphPreset', s.graphPresets], ['developerPreset', s.developerPresets], ['filter', s.filters], ['treemap', s.treemaps]]) if (value[key] !== undefined) { check(list.some(c => c.id === value[key]), `Unknown ${key}.`); s.selection[key] = value[key]; }
        });
        return send({ ok: true });
      }
      const match = url.pathname.match(/^\/api\/(inspections|presets|filters|treemaps|graphPresets|developerPresets)(?:\/([a-f0-9-]+))?$/);
      if (match && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const [, collection, id] = match;
        check(req.method === 'POST' ? !id : !!id, 'Invalid configuration route.');
        check(!(collection === 'inspections' && jobs.current?.status === 'running' && jobs.current.id === id), 'Wait for this inspection to finish or cancel it before editing.');
        const value = req.method === 'DELETE' ? null : (collection === 'inspections' ? validateInspection : collection === 'graphPresets' ? validateGraphPreset : collection === 'developerPresets' ? validateDeveloperPreset : collection === 'filters' ? validateFilter : collection === 'treemaps' ? validateTreemap : validatePreset)(await body(req));
        const saved = await store.update(s => {
          const list = s[collection], index = list.findIndex(c => c.id === id), key = collection === 'inspections' ? 'inspection' : collection === 'graphPresets' ? 'graphPreset' : collection === 'developerPresets' ? 'developerPreset' : collection === 'filters' ? 'filter' : collection === 'treemaps' ? 'treemap' : 'preset';
          check(!id || index >= 0, 'Configuration not found.');
          if (req.method === 'DELETE') { list.splice(index, 1); if (s.selection[key] === id) s.selection[key] = list[0]?.id ?? null; return { ok: true }; }
          const item = { ...(id ? list[index] : {}), ...value, id: id || randomUUID() };
          if (id) list[index] = item; else list.push(item);
          s.selection[key] = item.id;
          return item;
        });
        if (req.method === 'DELETE' && collection === 'inspections') await rm(resolve(directory, id), { recursive: true, force: true });
        return send(saved);
      }
      if (req.method === 'POST' && url.pathname === '/api/run') {
        const { id } = await body(req), config = state.inspections.find(c => c.id === id);
        check(config, 'Choose an inspection configuration.');
        return send(jobs.start(config), 202);
      }
      if (req.method === 'POST' && url.pathname === '/api/cancel') { await body(req); jobs.cancel(); return send({ ok: true }); }
      if (req.method === 'GET' && url.pathname === '/api/graph') {
        const c = state.inspections.find(c => c.id === url.searchParams.get('inspection'));
        const p = state.graphPresets.find(p => p.id === url.searchParams.get('preset'));
        check(c && p && usable(jobs.path(c.id)), 'Choose an inspection with results and a graph preset.');
        const config = validateGraphPreset(p).config;
        const result = await new Promise((accept, reject) => {
          const worker = new Worker(new URL('./graph-worker.mjs', import.meta.url), { workerData: { path: jobs.path(c.id), config } });
          const timer = setTimeout(() => { worker.terminate(); reject(new Error('Graph calculation timed out. Narrow the analysis scope.')); }, 120000);
          worker.once('message', value => { clearTimeout(timer); accept(value); });
          worker.once('error', error => { clearTimeout(timer); reject(error); });
          worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error(`Graph worker exited: ${code}`)); });
        });
        return send(result);
      }
      if (req.method === 'GET' && url.pathname === '/api/treemap') {
        const c = state.inspections.find(c => c.id === url.searchParams.get('inspection'));
        const p = scoringContext(state.presets.find(c => c.id === url.searchParams.get('preset')), true);
        check(c && p, 'Choose an inspection and treemap configuration.');
        check(usable(jobs.path(c.id)), 'Start inspection to generate results.');
        const showFunctions = url.searchParams.get('showFunctions') ?? 'false';
        check(['true', 'false'].includes(showFunctions), 'Invalid function view flag.');
        return send(await render(jobs.path(c.id), { ...p, developerPreset: state.developerPresets.find(d => d.id === state.selection.developerPreset) ?? state.developerPresets[0] ?? defaultDeveloperPreset(), options: { ...p.options, showFunctions: showFunctions === 'true', authorIdentities: c.authorIdentities ?? [] } }));
      }
      if (req.method === 'GET' && url.pathname === '/api/developers') {
        const c = state.inspections.find(c => c.id === url.searchParams.get('inspection'));
        const p = scoringContext(state.presets.find(p => p.id === url.searchParams.get('preset')));
        const d = state.developerPresets.find(p => p.id === url.searchParams.get('developerPreset'));
        check(c && p && d && usable(jobs.path(c.id)), 'Choose inspection results and both presets.');
        const options = { ...p.options, showFunctions: true, includeZeroArea: true, authorIdentities: c.authorIdentities ?? [] };
        return send(await render(jobs.path(c.id), { ...p, developerPreset: d, options }, false, 'developers'));
      }
      if (req.method === 'GET' && url.pathname === '/api/list') {
        const c = state.inspections.find(c => c.id === url.searchParams.get('inspection'));
        const p = scoringContext(state.presets.find(c => c.id === url.searchParams.get('preset')));
        check(c && p && usable(jobs.path(c.id)), 'Choose an inspection with results and a preset.');
        const options = { ...p.options, showFunctions: true, includeZeroArea: true, authorIdentities: c.authorIdentities ?? [] };
        return send(await render(jobs.path(c.id), { ...p, options }, false, true));
      }
      if (req.method === 'GET' && url.pathname === '/api/detail') {
        const c = state.inspections.find(c => c.id === url.searchParams.get('inspection'));
        const p = scoringContext(state.presets.find(c => c.id === url.searchParams.get('preset')));
        check(c && p && usable(jobs.path(c.id)), 'Choose an inspection with results and a preset.');
        const kind = url.searchParams.get('kind');
        check(['file', 'function'].includes(kind), 'Invalid item kind.');
        const options = { ...p.options, showFunctions: url.searchParams.get('showFunctions') === 'true', authorIdentities: c.authorIdentities ?? [] };
        if (url.searchParams.get('listContext') === 'true') Object.assign(options, { showFunctions: true, includeZeroArea: true });
        const result = await render(jobs.path(c.id), { ...p, developerPreset: state.developerPresets.find(d => d.id === state.selection.developerPreset) ?? state.developerPresets[0] ?? defaultDeveloperPreset(), options }, true);
        check(result.model?.ok, result.error || 'Unable to calculate scores.');
        return send(await inspectDetail(jobs.path(c.id), { ...c, preset: p }, url.searchParams.get('id'), kind, result.model, result.expanded));
      }
      if (req.method === 'GET' && ['/score-editor.js','/score-code/editor-entry.js'].includes(url.pathname)) return send(await editorBundle(), 200, 'text/javascript');
      const assets = { '/score-fields.js': ['score-fields.js', 'text/javascript'], '/score-code/catalog.mjs': ['../../score-code/catalog.mjs', 'text/javascript'], '/frontend-state.js': ['frontend-state.js', 'text/javascript'], '/developers-view.js': ['developers-view.js', 'text/javascript'], '/graph-view.js': ['graph-view.js', 'text/javascript'], '/graph.css': ['graph.css', 'text/css'], '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/detail-view.js': ['detail-view.js', 'text/javascript'], '/list-view.js': ['list-view.js', 'text/javascript'], '/progress-view.js': ['progress-view.js', 'text/javascript'], '/metric-help.js': ['metric-help.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/themes.css': ['themes.css', 'text/css'], '/theme.js': ['theme.js', 'text/javascript'], '/preset-fields.js': ['preset-fields.js', 'text/javascript'], '/treemap/src/catalog.mjs': ['../../treemap/src/catalog.mjs', 'text/javascript'] };
      if (req.method === 'GET' && assets[url.pathname]) { const [file, type] = assets[url.pathname]; return send(await readFile(new URL(`./public/${file}`, import.meta.url), 'utf8'), 200, type); }
      send({ error: 'Not found.' }, 404);
    } catch (error) { send({ error: error.message }, error.status ?? 500); }
  });
  return { server, store, jobs, async close() { jobs.cancel(); await jobs.done; await renderer.close(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const port = Number(process.env.PORT || 3210);
  app.server.listen(port, '127.0.0.1', () => console.log(`Code View: http://127.0.0.1:${app.server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
