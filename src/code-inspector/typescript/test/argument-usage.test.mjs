import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../src/main.mjs';
import { calculateTreeMap } from '../../../treemap/src/index.mjs';
import { readFileSync } from 'node:fs';

test('recursive argument usage persists and scores exact counts and incomplete minima', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'argument-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'tsconfig.json'), output = path.join(dir, 'analysis.sqlite');
  writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' }, include: ['*.ts'] }));
  writeFileSync(path.join(dir, 'a.ts'), `
function A() { B(C); }
function B(cb:()=>void) { F(G); }
function C() { D(E); }
function D(cb:()=>void) {}
function E() {}
function F(cb:()=>void) {}
function G() {}
function duplicates() { D(E); D(E); two(E,E); }
function two(a:()=>void,b:()=>void) {}
function cycle() { D(cycle); cycle(); }
function externalUse() { [1].map(() => { D(E); return 1; }); }
function forward(callback:()=>void) { D(callback); }
function entry() { forward(C); }
class Box { constructor(cb:()=>void) {} }
function construct() { new Box(E); }
function partial() { D(E); missing(E); }
function uncertain(x: any) { D(x); }
function leaf() { console.log(1); }
function diamond() { left(); right(); }
function left() { shared(); }
function right() { shared(); }
function shared() { D(E); }
function partialExternal(x: any) { [1].map(E); missing(x); }
function spread(args: any[]) { D(...args); }

`);
  const result = main(['-p', config, '-o', output]);
  const db = new DatabaseSync(output); t.after(() => db.close());
  const f = name => db.prepare('SELECT * FROM code_functions WHERE name=?').get(name);
  assert.equal(f('A').function_argument_usage_internal, 3);
  assert.equal(f('duplicates').function_argument_usage_internal, 4);
  assert.equal(f('cycle').function_argument_usage_internal, 1);
  assert.equal(f('externalUse').function_argument_usage_internal, 1);
  assert.equal(f('externalUse').function_argument_usage_external, 1);
  assert.equal(f('entry').minimum_function_argument_usage_internal, 3);
  assert.equal(f('construct').function_argument_usage_internal, 1);
  assert.equal(f('partial').function_argument_usage_internal, null);
  assert.equal(f('partial').minimum_function_argument_usage_internal, 1);
  assert.equal(f('uncertain').function_argument_usage_internal, null);
  assert.equal(f('uncertain').minimum_function_argument_usage_internal, 0);
  assert.equal(f('leaf').function_argument_usage_external, 0);
  assert.equal(f('diamond').function_argument_usage_internal, 1);
  assert.equal(f('partialExternal').function_argument_usage_external, null);
  assert.equal(f('partialExternal').minimum_function_argument_usage_external, 1);
  assert.equal(f('spread').function_argument_usage_complete, 0);
  assert.ok(result.argumentUsages.length);
  const exactMetric = 'code_functions.function_argument_usage_internal';
  const exact = await calculateTreeMap(readFileSync(output), { area: 'code_files.size_bytes', scores: [{ metrics: [{ metric: exactMetric }] }] }, { showFunctions: true });
  assert.equal(exact.ok, true);
  assert.equal(exact.files[0].children.find(n => n.id === f('partial').id).scores.length, 0);

  for (const aggregation of ['sum', 'max']) {
    const metric = 'code_functions.minimum_function_argument_usage_internal';
    const model = await calculateTreeMap(readFileSync(output), { area: 'code_files.size_bytes', scores: [{ metrics: [{ metric, aggregation }] }] }, { showFunctions: true });
    assert.equal(model.ok, true, JSON.stringify(model.diagnostics));
    assert.ok(model.files[0].heat > 0);
    const partial = model.files[0].children.find(n => n.id === f('partial').id);
    assert.equal(partial.metrics[metric], 1);
    assert.ok(partial.scores.some(s => s.contributions.some(c => c.metric === metric)));
  }
});
