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
  await writeFile(join(repo, 'example.ts'), 'export function example(x: number, options = {enabled:false}) { options.enabled = true; const local = {value:0}; local.value++; return x > 2 ? x : 0; }\n');
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
  const detailURL = `detail?inspection=${inspection.id}&preset=${state.presets[0].id}&kind=file&id=example.ts`;
  const detail = await call(detailURL);
  assert.equal(detail.status, 200, JSON.stringify(detail.value));
  assert.equal(detail.value.warnings.length, 0);
  assert.equal(detail.value.node.heat, JSON.parse(rendered.value.treeMapHtml.match(/\"heat\":([0-9.]+)/)[1]));
  assert.match(detail.value.source, /export function example/);
  assert.deepEqual(detail.value.exports.map(e => e.name), ['example']);
  const listing = await call(`list?inspection=${inspection.id}&preset=${state.presets[0].id}`);
  assert.equal(listing.status,200,JSON.stringify(listing.value));
  assert.equal(listing.value.files.length,1);assert.equal(listing.value.functions.length,1);
  assert.equal(listing.value.traitsAvailable,true);
  assert.equal(listing.value.functions[0].is_exported,1);
  assert.ok(listing.value.functions[0].definite>0);
  const listItem = await call(`${detailURL}&listContext=true`);
  assert.equal(listItem.value.node.heat,listing.value.files[0].score);
  const fn = detail.value.functions[0];
  const fnDetail = await call(`detail?inspection=${inspection.id}&preset=${state.presets[0].id}&kind=function&id=${encodeURIComponent(fn.id)}`);
  assert.equal(fnDetail.status,200,JSON.stringify(fnDetail.value));
  assert.match(fnDetail.value.entity.signature,/number/);
  assert.ok(fnDetail.value.mutations.some(m=>m.symbol_name==='options' && m.line===1));
  assert.ok(fnDetail.value.mutations.every(m=>m.symbol_name!=='local'));
  assert.equal((await call(detailURL.replace('example.ts','../secret'))).status,404);
  await writeFile(join(repo, 'example.ts'), '// current edited source\n');
  const edited = await call(detailURL);
  assert.match(edited.value.source, /current edited source/);
  assert.ok(edited.value.warnings.some(w=>/Uncommitted/.test(w)));
  git('add','example.ts');git('commit','-m','edit after inspection');
  assert.ok((await call(detailURL)).value.warnings.some(w=>/differs from inspected commit/.test(w)));
  git('revert','--no-edit','HEAD');

  const functionView = await call(`treemap?inspection=${inspection.id}&preset=${state.presets[0].id}&showFunctions=true`);
  assert.equal(functionView.value.ok, true, JSON.stringify(functionView.value));
  assert.match(functionView.value.treeMapHtml, /Outside functions/);
  assert.match(functionView.value.treeMapHtml, /exclusive_size_bytes/);
  assert.equal((await call(`treemap?inspection=${inspection.id}&preset=${state.presets[0].id}&showFunctions=invalid`)).status,400);
  assert.equal((await openStore(data)).get().presets[0].options.showFunctions,undefined);
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

test('old treemap presets are discarded once while inspections, results and their selection survive',async t=>{
  const dir=await temporary(t),old={inspections:[{id:'repo',name:'Keep',result:{completedAt:'2026-01-01'},repository:'/repo'}],presets:[{id:'old',name:'Old',config:{}}],selection:{inspection:'repo',preset:'old'}};
  await writeFile(join(dir,'config.json'),JSON.stringify(old));
  const store=await openStore(dir),state=store.get();
  assert.deepEqual(state.inspections,old.inspections);
  assert.equal(state.selection.inspection,'repo');
  assert.equal(state.presets.length,1);assert.notEqual(state.presets[0].id,'old');
  assert.equal(state.selection.preset,state.presets[0].id);
  validatePreset(state.presets[0]);
  await store.update(s=>{s.presets[0].name='Customized';});
  assert.equal((await openStore(dir)).get().presets[0].name,'Customized');
});

test('server rejects invalid scoring options and unknown catalog metrics before saving',()=>{
  const preset=defaultPreset();
  for(const config of [
    {...preset.config,operation:'average'}, {...preset.config,quantile:101},
    {...preset.config,scores:[{name:'Bad',normalize:'yes',metrics:[{metric:'code_functions.count'}]}]},
    {...preset.config,scores:[{name:'Bad',max:0,metrics:[{metric:'code_functions.count'}]}]},
    {...preset.config,scores:[{name:'Bad',metrics:[{metric:'code_diagnostics.code'}]}]},
  ]) assert.throws(()=>validatePreset({...preset,config}),error=>error.status===400);
  const config={...preset.config,operation:'quantile',quantile:25,scores:[{name:'Q',normalize:false,max:80,metrics:[{metric:'code_functions.cyclomatic_complexity',min:10,aggregation:'quantile',quantile:90,factor:2}]}]};
  assert.deepEqual(validatePreset({...preset,config}).config,config);
});
