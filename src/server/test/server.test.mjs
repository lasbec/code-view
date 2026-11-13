import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server.mjs';
import { openStore, validateInspection, validatePreset, defaultPreset } from '../store.mjs';
import { metricHelp } from '../public/metric-help.js';

async function temporary(t) { const dir = await mkdtemp(join(tmpdir(), 'code-view-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
test('validates repository boundaries, commit limits and treemap thresholds', () => {
  const c = { name: 'test', repository: '/tmp/repo', tsconfig: 'tsconfig.json' };
  assert.throws(() => validateInspection({ ...c, tsconfig: '../secret.json' }));
  assert.throws(() => validateInspection({ ...c, commits: 1.5 }));
  assert.equal(validateInspection(c).commits, null);
  assert.throws(() => validatePreset({ ...defaultPreset(), config: { ...defaultPreset().config, heat: { min: 20, max: 10 } } }));
});
test('author identities normalize emails and reject ambiguous or malformed mappings', () => {
  const c = { name: 'test', repository: '/tmp/repo', tsconfig: 'tsconfig.json' };
  assert.deepEqual(validateInspection(c).authorIdentities, []);
  assert.deepEqual(validateInspection({ ...c, authorIdentities: [
    { name: ' Alice ', email: ' ALICE@WORK.TEST ', aliases: ['Alice@Private.Test'] },
  ] }).authorIdentities, [{ name: 'Alice', email: 'alice@work.test', aliases: ['alice@private.test'] }]);
  for (const authorIdentities of [null, {}, [{ name: '', email: 'a@b.test' }],
    [{ name: 'A', email: 'invalid' }], [{ name: 'A', email: 'a@b.test', aliases: 'alias@b.test' }],
    [{ name: 'A', email: 'a@b.test', aliases: ['invalid'] }],
    [{ name: 'A', email: 'a@b.test', extra: true }],
    [{ name: 'A', email: 'a@b.test', aliases: ['alias@b.test'] }, { name: 'B', email: 'ALIAS@B.TEST' }],
  ]) assert.throws(() => validateInspection({ ...c, authorIdentities }), error => error.status === 400);
});
test('serialized storage survives restart without losing concurrent changes', async t => {
  const dir = await temporary(t), store = await openStore(dir);
  await Promise.all([store.update(s => { s.selection.inspection = 'first'; }), store.update(s => { s.selection.preset = 'second'; })]);
  assert.deepEqual((await openStore(dir)).get().selection, { inspection: 'first', preset: 'second' });
});
test('HTTP lifecycle handles a branch matching a path, renders results, and retains results on failure and cancellation', { timeout: 60000 }, async t => {
  const dir = await temporary(t), repo = join(dir, 'repository'); await mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'master'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  await writeFile(join(repo, 'master'), 'Branch and path share a name.\n');
  await writeFile(join(repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', noLib: true }, include: ['*.ts'] }));
  await writeFile(join(repo, 'example.ts'), 'export function example(x: number) { return x > 2 ? x : 0; }\n');
  await writeFile(join(repo, 'excluded.ts'), 'export const excluded = 1;');
  git('add', '.'); git('commit', '-m', 'fixture');
  const data = join(dir, 'data'), app = await createApp({ directory: data });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/`;
  const helpAsset = await fetch(new URL('/metric-help.js', base));
  assert.equal(helpAsset.status, 200);
  assert.match(helpAsset.headers.get('content-type'), /text\/javascript/);
  const call = async (path, method = 'GET', value, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(value ? { body: JSON.stringify(value) } : {}) });
    return { status: res.status, value: await res.json() };
  };
  assert.equal((await call('state')).value.inspections.length, 0);
  assert.equal((await call('selection', 'POST', {}, { Origin: 'https://evil.example' })).status, 400);
  const config = { name: 'Example', repository: repo, tsconfig: 'tsconfig.json', exclude: ['excluded.ts'] };
  const { value: inspection } = await call('inspections', 'POST', config);
  assert.ok(inspection.id);
  assert.equal((await call('run', 'POST', { id: inspection.id })).status, 202);
  assert.equal((await call('run', 'POST', { id: inspection.id })).status, 400);
  await app.jobs.done;
  assert.equal(app.jobs.current.status, 'succeeded', app.jobs.current.error);
  assert.deepEqual(app.jobs.current.progress, {
    code: { status: 'done', completed: 1, total: 1 },
    git: { status: 'done', completed: 1, total: 1 },
  });
  assert.doesNotMatch(app.jobs.current.log, /CODE_VIEW_PROGRESS/);
  const state = (await call('state')).value;
  assert.equal(state.inspections[0].hasResults, true);
  const rendered = await call(`treemap?inspection=${inspection.id}&preset=${state.presets[0].id}`);
  assert.equal(rendered.value.ok, true, JSON.stringify(rendered.value));
  assert.match(rendered.value.treeMapHtml, /example.ts/);
  assert.ok(rendered.value.treeMapWarningsHtml);
  // Compare against the catalog from real inspector schemas so new selectable
  // columns cannot silently ship without descriptions and examples.
  const documented = new Map(metricHelp.map(entry => [entry.metric, entry]));
  assert.deepEqual(rendered.value.metrics.filter(entry => !documented.has(entry.metric)), []);
  assert.equal(documented.size, metricHelp.length, 'Metric help names must be unique.');
  for (const { metric } of rendered.value.metrics) {
    const entry = documented.get(metric);
    assert.ok(entry.short && entry.long && entry.example, `Incomplete help for ${metric}`);
  }
  const authorIdentities = [{ name: 'Canonical Test', email: 'canonical@example.test', aliases: ['test@example.test'] }];
  assert.equal((await call(`inspections/${inspection.id}`, 'PUT', { ...config, authorIdentities })).status, 200);
  const updated = (await call('state')).value.inspections[0];
  assert.equal(updated.stale, false, 'Changing author identities does not require another inspection.');
  assert.deepEqual((await openStore(data)).get().inspections[0].authorIdentities, authorIdentities);
  const renamed = await call(`treemap?inspection=${inspection.id}&preset=${state.presets[0].id}`);
  assert.equal(renamed.value.ok, true);
  assert.match(renamed.value.treeMapHtml, /"name":"Canonical Test","email":"canonical@example.test","commits":1/);
  const before = await readFile(app.jobs.path(inspection.id));
  // A bad rerun must never publish a partial database over usable results.
  await call(`inspections/${inspection.id}`, 'PUT', { ...config, tsconfig: 'missing.json' });
  assert.equal((await call('state')).value.inspections[0].stale, true);
  await call('run', 'POST', { id: inspection.id }); await app.jobs.done;
  assert.equal(app.jobs.current.status, 'failed');
  assert.deepEqual(await readFile(app.jobs.path(inspection.id)), before);
  await call(`inspections/${inspection.id}`, 'PUT', config);
  await call('run', 'POST', { id: inspection.id });
  await call('cancel', 'POST', {}); await app.jobs.done;
  assert.equal(app.jobs.current.status, 'cancelled');
  assert.deepEqual(await readFile(app.jobs.path(inspection.id)), before);
  const persisted = (await openStore(data)).get();
  assert.equal(persisted.selection.inspection, inspection.id);
});
