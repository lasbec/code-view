import http from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { openStore, validateInspection, validatePreset, check } from './store.mjs';
import { Jobs, usable, fingerprint } from './jobs.mjs';

async function body(req) {
  check(req.headers['content-type']?.split(';')[0] === 'application/json', 'Send application/json.');
  let text = '';
  for await (const chunk of req) { text += chunk; check(Buffer.byteLength(text) <= 262144, 'Request is too large.'); }
  try { return JSON.parse(text); } catch { check(false, 'Invalid JSON.'); }
}
function render(path, preset) {
  return new Promise((accept, reject) => {
    const worker = new Worker(new URL('./render-worker.mjs', import.meta.url), { workerData: { path, preset } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Treemap calculation timed out.')); }, 120000);
    worker.once('message', result => { clearTimeout(timer); accept(result); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error(`Treemap worker exited: ${code}`)); });
  });
}
export async function createApp({ directory = process.env.CODE_VIEW_DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)) } = {}) {
  directory = resolve(directory);
  const store = await openStore(directory), jobs = new Jobs(directory, store);
  const server = http.createServer(async (req, res) => {
    const send = (value, status = 200, type = 'application/json') => { res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(type === 'application/json' ? JSON.stringify(value) : value); };
    try {
      // Reject DNS rebinding and cross-origin browser requests to this local service.
      check(/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? ''), 'Invalid host.');
      if (req.headers.origin) check(['http://127.0.0.1', 'http://localhost'].some(base => req.headers.origin === `${base}:${server.address().port}`), 'Cross-origin requests are not allowed.');
      check(!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] !== 'cross-site', 'Cross-site requests are not allowed.');
      const url = new URL(req.url, 'http://localhost');
      const state = store.get();
      if (req.method === 'GET' && url.pathname === '/api/state') {
        for (const c of state.inspections) { c.hasResults = usable(jobs.path(c.id)); c.stale = c.hasResults && c.result?.fingerprint !== fingerprint(c); }
        return send({ ...state, job: jobs.current });
      }
      if (req.method === 'POST' && url.pathname === '/api/selection') {
        const value = await body(req);
        await store.update(s => {
          for (const [key, list] of [['inspection', s.inspections], ['preset', s.presets]]) if (value[key] !== undefined) { check(list.some(c => c.id === value[key]), `Unknown ${key}.`); s.selection[key] = value[key]; }
        });
        return send({ ok: true });
      }
      const match = url.pathname.match(/^\/api\/(inspections|presets)(?:\/([a-f0-9-]+))?$/);
      if (match && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const [, collection, id] = match;
        check(req.method === 'POST' ? !id : !!id, 'Invalid configuration route.');
        check(!(collection === 'inspections' && jobs.current?.status === 'running' && jobs.current.id === id), 'Wait for this inspection to finish or cancel it before editing.');
        const value = req.method === 'DELETE' ? null : (collection === 'inspections' ? validateInspection : validatePreset)(await body(req));
        const saved = await store.update(s => {
          const list = s[collection], index = list.findIndex(c => c.id === id), key = collection === 'inspections' ? 'inspection' : 'preset';
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
      if (req.method === 'GET' && url.pathname === '/api/treemap') {
        const c = state.inspections.find(c => c.id === url.searchParams.get('inspection'));
        const p = state.presets.find(c => c.id === url.searchParams.get('preset'));
        check(c && p, 'Choose an inspection and treemap configuration.');
        check(usable(jobs.path(c.id)), 'Start inspection to generate results.');
        return send(await render(jobs.path(c.id), p));
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/progress-view.js': ['progress-view.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && assets[url.pathname]) { const [file, type] = assets[url.pathname]; return send(await readFile(new URL(`./public/${file}`, import.meta.url), 'utf8'), 200, type); }
      send({ error: 'Not found.' }, 404);
    } catch (error) { send({ error: error.message }, error.status ?? 500); }
  });
  return { server, store, jobs, async close() { jobs.cancel(); await jobs.done; await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const port = Number(process.env.PORT || 3210);
  app.server.listen(port, '127.0.0.1', () => console.log(`Code View: http://127.0.0.1:${app.server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
