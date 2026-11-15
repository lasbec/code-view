import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { ensureScores } from '../../score-code/persistence.mjs';

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'independent-inspections-')), repository = join(directory, 'repo');
  await mkdir(join(repository, 'src'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Example'); git('config', 'user.email', 'example@test.local');
  await writeFile(join(repository, 'src/tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true }, include: ['*.ts'] }));
  await writeFile(join(repository, 'src/example.ts'), 'export function example(x: number) { return x > 0 ? x : 0; }\n');
  git('add', '.'); git('commit', '-m', 'initial');
  const app = await createApp({ directory: join(directory, 'data') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api/`;
  const call = async (path, method = 'GET', value) => {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(20000), ...(value ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  const config = { name: 'Example', repository, tsconfig: 'src/tsconfig.json', ...overrides };
  const { value: saved } = await call('inspections', 'POST', config);
  const current = () => app.store.get().inspections[0];
  const start = inspector => call('run', 'POST', { id: saved.id, inspector });
  const save = changes => call(`inspections/${saved.id}`, 'PUT', { ...current(), ...changes });
  const state = async () => (await call('state')).value;
  return { app, repository, git, call, saved, current, start, save, state };
}
const tables = path => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name); }
  finally { db.close(); }
};
const historyScore = { fields: [{ id: 'history', kind: 'file', code: 'metrics.git_file_changes_count.length' }] };

test('Git runs without a valid tsconfig and publishes when Code fails', { timeout: 30000 }, async t => {
  const f = await fixture(t, { tsconfig: 'missing.json' });
  assert.equal((await f.start('both')).status, 202);
  await f.app.jobs.done;
  const jobs = f.app.jobs.list;
  assert.equal(jobs.find(j => j.inspector === 'code').status, 'failed');
  assert.equal(jobs.find(j => j.inspector === 'git').status, 'succeeded');
  const state = await f.state(), c = state.inspections[0];
  assert.equal(c.hasResults, false);
  assert.equal(c.inspectorStates.git.hasResults, true);
  assert.equal((await f.call(`treemap?inspection=${c.id}&preset=${state.presets[0].id}`)).status, 400);
  assert.ok(tables(f.app.jobs.path(c.id, c.results.git.filename)).every(name => name.startsWith('git_')));
  assert.equal((await f.save({ tsconfig: 'src/tsconfig.json' })).status, 200);
  assert.equal((await f.state()).inspections[0].inspectorStates.git.stale, false);
  await f.start('code'); await f.app.jobs.done;
  assert.equal((await f.state()).inspections[0].hasResults, true);
});

test('Code-only views preserve repository-relative filters and missing Git metrics; new results invalidate scores independently', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.start('code'); await f.app.jobs.done;
  assert.equal(f.app.jobs.list[0].status, 'succeeded', f.app.jobs.list[0].error);
  const source = f.current().results.code.filename;
  const sourcePath = f.app.jobs.path(f.saved.id, source), bytes = await readFile(sourcePath);
  assert.ok(tables(sourcePath).every(name => name.startsWith('code_')));
  const codeOnlyPath = f.app.jobs.analysis(f.current());
  const missing = ensureScores(codeOnlyPath, historyScore, { include: ['src/**'] });
  assert.equal(missing.files.length, 1);
  assert.equal(missing.files[0].path, 'src/example.ts');
  assert.equal(missing.files[0].score, null);
  assert.ok(missing.files[0].error);
  const state = await f.state();
  const listing = await f.call(`list?inspection=${f.saved.id}&preset=${state.presets[0].id}`);
  assert.equal(listing.status, 200, JSON.stringify(listing.value));
  assert.equal(listing.value.files.length, 1);
  const detail = await f.call(`detail?inspection=${f.saved.id}&preset=${state.presets[0].id}&kind=file&id=example.ts`);
  assert.equal(detail.status, 200, JSON.stringify(detail.value));
  assert.equal(detail.value.warnings.length, 0, 'Code source consistency does not depend on a Git inspection');
  await f.start('git'); await f.app.jobs.done;
  const pair1 = f.app.jobs.analysis(f.current());
  assert.notEqual(pair1, codeOnlyPath);
  assert.equal(ensureScores(pair1, historyScore, {}).files[0].score, 1);
  assert.equal(ensureScores(pair1, historyScore, {}).cached, true);
  await writeFile(join(f.repository, 'src/example.ts'), 'export function example(x: number) { if (x > 1) return x; if (x < 0) return -x; return 0; }\n');
  f.git('add', '.'); f.git('commit', '-m', 'second');
  await f.start('git'); await f.app.jobs.done;
  const pair2 = f.app.jobs.analysis(f.current());
  assert.notEqual(pair2, pair1);
  assert.equal(f.current().results.code.filename, source);
  assert.deepEqual(await readFile(sourcePath), bytes, 'Git and scoring never modify Code results');
  const updated = ensureScores(pair2, historyScore, {});
  assert.equal(updated.cached, false); assert.equal(updated.files[0].score, 2);
  assert.equal(ensureScores(pair1, historyScore, {}).files[0].score, 1, 'Existing consumers keep their original pair');
  const gitFilename = f.current().results.git.filename;
  const codeScore = { fields: [{ id: 'complexity', kind: 'function', code: 'metrics.cyclomatic_complexity', aggregation: 'sum(scores)' }] };
  const oldComplexity = ensureScores(pair2, codeScore, {}).files[0].score;
  await f.start('code'); await f.app.jobs.done;
  const pair3 = f.app.jobs.analysis(f.current());
  assert.notEqual(pair3, pair2); assert.equal(f.current().results.git.filename, gitFilename);
  assert.ok(ensureScores(pair3, codeScore, {}).files[0].score > oldComplexity);
  assert.equal(ensureScores(pair3, historyScore, {}).files[0].score, 2);
  assert.ok(tables(sourcePath).every(name => name.startsWith('code_')), 'Scores only persist in the consumer database');
});

test('parallel starts isolate cancellation, capture configuration, and invalidate only relevant inputs', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.start('code')).status, 202);
  assert.equal((await f.start('code')).status, 400);
  assert.equal((await f.start('both')).status, 400, 'Both is rejected atomically when one inspector is busy');
  assert.equal(f.app.jobs.list.length, 1);
  assert.equal((await f.start('git')).status, 202);
  assert.equal(f.app.jobs.list.filter(j => j.status === 'running').length, 2);
  assert.equal((await f.call(`inspections/${f.saved.id}`, 'DELETE')).status, 400);
  assert.equal((await f.save({ exclude: ['example.ts'] })).status, 200);
  assert.equal((await f.call('cancel', 'POST', { id: f.saved.id, inspector: 'code' })).status, 200);
  await f.app.jobs.done;
  assert.equal(f.app.jobs.list.find(j => j.inspector === 'code').status, 'cancelled');
  assert.equal(f.app.jobs.list.find(j => j.inspector === 'git').status, 'succeeded');
  assert.equal((await f.state()).inspections[0].inspectorStates.git.stale, false);
  await f.save({ exclude: [] });
  await f.start('code');
  await f.save({ exclude: ['example.ts'] });
  await f.app.jobs.done;
  const c = (await f.state()).inspections[0];
  assert.equal(c.inspectorStates.code.hasResults, true);
  assert.equal(c.inspectorStates.code.stale, true, 'Finished run uses its start configuration');
  assert.equal(c.inspectorStates.git.stale, false);
  await f.save({ exclude: [], commits: 1 });
  const changed = (await f.state()).inspections[0];
  assert.equal(changed.inspectorStates.code.stale, false);
  assert.equal(changed.inspectorStates.git.stale, true);
  const prior = f.current().results;
  await f.save({ tsconfig: 'missing.json' });
  await f.start('code'); await f.app.jobs.done;
  assert.equal(f.app.jobs.list.find(j => j.inspector === 'code').status, 'failed');
  assert.deepEqual(f.current().results, prior, 'Failed rerun preserves both successful results');
});

test('switching repositories retires old and in-flight results even after switching back', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.start('git'); await f.app.jobs.done;
  await f.start('code');
  await f.save({ repository: join(f.repository, 'other') });
  await f.save({ repository: f.repository });
  await f.app.jobs.done;
  assert.deepEqual(f.current().results, {});
  assert.equal((await f.state()).inspections[0].hasResults, false);
  assert.match(f.app.jobs.list.find(j => j.inspector === 'code').phase, /discarded/);
});

test('existing combined results remain available while each inspector independently supersedes its half', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.start('both'); await f.app.jobs.done;
  const original = f.current(), combined = f.app.jobs.analysis(original);
  ensureScores(combined, historyScore, {});
  const { copyFile } = await import('node:fs/promises');
  await copyFile(combined, f.app.jobs.path(original.id, 'analysis.sqlite'));
  await f.app.store.update(s => {
    const c = s.inspections[0];
    c.result = { completedAt: c.results.code.completedAt, branch: 'main', fingerprint: JSON.stringify(Object.fromEntries(['repository', 'tsconfig', 'commits', 'include', 'exclude'].map(key => [key, c[key]]))) };
    delete c.results;
  });
  let c = (await f.state()).inspections[0];
  assert.equal(c.hasResults, true); assert.equal(c.stale, false);
  const legacyPair = f.app.jobs.analysis(f.current());
  assert.equal(tables(legacyPair).some(name => name.startsWith('score_')), false, 'Consumer composition excludes inherited score caches');
  await f.start('code'); await f.app.jobs.done;
  c = f.current();
  assert.match(c.results.code.filename, /^code-/);
  assert.equal(c.results.git.filename, 'analysis.sqlite');
  assert.equal(ensureScores(f.app.jobs.analysis(c), historyScore, {}).files[0].score, 1);
});
