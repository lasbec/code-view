import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateScores } from '../calculate.mjs';
import { ensureScores } from '../persistence.mjs';
import { inspectFormula, defaultName, createEvaluator } from '../formulas.mjs';
import { fixture, definition } from './fixture.mjs';

test('function contributions aggregate separately, file contributions add, and function scores exclude file values', t => {
  const { db } = fixture(t); t.after(() => db.close());
  const result = calculateScores(db, definition);
  assert.deepEqual(result.files.map(f => [f.id,f.score]), [['a.ts',57],['b.ts',17],['empty.ts',0]]);
  assert.deepEqual(result.functions.map(f => [f.id,f.score]), [['a1',9],['a2',21],['b1',12]]);
  assert.equal(result.files[0].contributions[1].value,7);
});
test('path and inclusive Git date filters define the calculation population', t => {
  const { db } = fixture(t); t.after(() => db.close());
  const result = calculateScores(db, definition, { include: ['*.ts'], exclude: ['b.ts','empty.ts'], since: '2026-01-01T00:00:00Z', until: '2026-01-01T00:00:00Z' });
  assert.deepEqual(result.files.map(f => [f.id,f.score]), [['a.ts',47]]);
  assert.deepEqual(result.functions.map(f => f.id), ['a1','a2']);
});
test('event arrays are per function, missing measurements are null, empty collections are arrays', t => {
  const { db } = fixture(t); t.after(() => db.close());
  const result = calculateScores(db, { fields: [{ id:'events',kind:'function',code:'sum(metrics.code_parameters_mutation_count)',aggregation:'sum(scores)' }] });
  assert.deepEqual(result.functions.map(f => f.score), [7,1,0]);
  const missing = calculateScores(db, { fields: [{id:'missing',kind:'function',code:'metrics.call_depth',aggregation:'sum(scores)'}] });
  assert.equal(missing.files[0].score,6); assert.equal(missing.files[1].score,null);
  assert.match(missing.functions[2].error,/finite number/);
});
test('syntax, unknown names and non-finite results become null with diagnostics and propagate', t => {
  const { db } = fixture(t); t.after(() => db.close());
  for (const code of ['metrics.cyclomatic_complexitiy', 'suum([1])', 'return (', 'Infinity', 'undefined', 'return Promise.resolve(1)', 'throw null;', 'throw "bad";']) {
    const result = calculateScores(db, { fields: [{ id:'bad',kind:'function',name:'Broken',autoName:false,code,aggregation:'sum(scores)' }] });
    assert.equal(result.functions[0].score,null,code); assert.ok(result.functions[0].error,code);
    assert.equal(result.files[0].score,null,code); assert.equal(result.files[2].score,0,code);
  }
});
test('failure in one function preserves other functions and independent contribution values', t => {
  const { db } = fixture(t); t.after(() => db.close());
  const result = calculateScores(db,{ fields:[...definition.fields,{id:'bad',kind:'function',code:'if(metrics.cyclomatic_complexity === 3) throw new Error("bad first"); return 1;',aggregation:'sum(scores)'}] });
  assert.equal(result.functions[0].score,null); assert.equal(result.functions[1].score,22);
  assert.equal(result.files[0].score,null); assert.equal(result.files[1].score,18);
  assert.equal(result.files[0].contributions[0].value,20);
});
test('static checking detects metrics and Lodash typos, scope errors and malformed blocks', () => {
  for (const [code,scope] of [['metrics.typo','function'],['_.suum(scores)','aggregation'],['summ(scores)','aggregation'],['metrics.cyclomatic_complexity','file'],['{','function']]) assert.ok(inspectFormula(code,scope).diagnostics.length,code);
  assert.equal(inspectFormula('sum(scores)','aggregation').diagnostics.length,0);
  assert.equal(inspectFormula('const x = metrics.cyclomatic_complexity; return x;','function').diagnostics.length,0);
  assert.ok(inspectFormula('metrics.','function').diagnostics.some(d => d.syntax));
  assert.equal(defaultName('/* metrics.call_depth */ metrics.cyclomatic_complexity + metrics.call_depth','function'),'Cyclomatic complexity');
});
test('compiled JavaScript supports expressions, blocks, Lodash, and signed numbers without server globals', () => {
  const compile = createEvaluator();
  assert.equal(compile('sum(scores)')(undefined,[2,3]).value,5);
  assert.equal(compile('const values = _.map(scores, x => x*2); return sum(values);')(undefined,[2,3]).value,10);
  assert.equal(compile('-3')().value,-3);
  assert.match(compile('process.exit()')().error,/not defined/);
});
test('SQLite stores named contributions, errors and totals atomically and reuses independent combinations', t => {
  const { path,db } = fixture(t); db.close();
  const first = ensureScores(path,definition,{}), cached = ensureScores(path,definition,{});
  assert.equal(first.cached,false); assert.equal(cached.cached,true);
  assert.equal(cached.runId,first.runId); assert.equal(cached.files.find(f=>f.id==='a.ts').score,57);
  assert.deepEqual(cached.files.find(f=>f.id==='a.ts').contributions,first.files[0].contributions);
  const filtered = ensureScores(path,definition,{include:['a.ts']}); assert.notEqual(filtered.runId,first.runId);
  const changed = structuredClone(definition); changed.fields[0].code='metrics.cyclomatic_complexity';
  assert.notEqual(ensureScores(path,changed,{}).runId,first.runId);
});

test('a hanging formula becomes null and the worker continues with valid fields and later requests', {timeout:20000}, async t => {
  const {path,db}=fixture(t);db.close();
  const {createScoreWorker}=await import('../worker-client.mjs');
  const worker=createScoreWorker({fieldTimeoutMs:100});t.after(()=>worker.close());
  const result=await worker.request({path,definition:{fields:[{id:'hang',kind:'function',code:'while(true) {}',aggregation:'sum(scores)'},{id:'valid',kind:'file',code:'3'}]},filter:{}});
  assert.equal(result.files.find(f=>f.id==='a.ts').score,null);
  assert.match(result.functions[0].error,/exceeded/);
  assert.equal(result.files[0].contributions[1].value,3);
  const later=await worker.request({path,definition,filter:{}});
  assert.equal(later.files.find(f=>f.id==='a.ts').score,57);
});

test('incoming references use the target function even when their source is outside the path filter', t => {
  const {db}=fixture(t);t.after(()=>db.close());
  db.exec(`CREATE TABLE code_function_references(function_id TEXT,target_id TEXT,file_id TEXT);
    INSERT INTO code_function_references VALUES('b1','a1','b.ts'),('b1','a1','b.ts'),('a1','b1','a.ts');`);
  const result=calculateScores(db,{fields:[{id:'refs',kind:'function',code:'metrics.code_function_references_incoming_count.length',aggregation:'sum(scores)'}]},{include:['a.ts']});
  assert.equal(result.functions.find(f=>f.id==='a1').score,2);
  assert.equal(result.files[0].score,2);assert.equal(result.functions.length,2);
});
test('counter and scalar queries do not multiply values through joins', t => {
  const {db}=fixture(t);t.after(()=>db.close());
  const result=calculateScores(db,{fields:[{id:'counter',kind:'function',code:'metrics.cyclomatic_complexity + metrics.code_parameters_count.length',aggregation:'sum(scores)'}]});
  assert.equal(result.functions.find(f=>f.id==='a1').score,5);
  assert.equal(result.files[0].score,13);
});

test('external reference metrics count occurrences and deduplicate source files at each target scope', t => {
  const {db}=fixture(t);t.after(()=>db.close());
  db.exec(`CREATE TABLE code_function_references(function_id TEXT,target_id TEXT,file_id TEXT);
    INSERT INTO code_function_references VALUES
    ('b1','a1','b.ts'),('b1','a1','b.ts'),('b1','a2','b.ts'),
    (NULL,'a1','outside.ts'),('a1','a1','a.ts'),('a1','a2','a.ts'),
    ('b1','unresolved','b.ts');`);
  for (const [field, functionScores, fileScore] of [
    ['incoming_external_count',[3,1],4],
    ['incoming_external_file_count',[2,1],2],
  ]) {
    const result=calculateScores(db,{fields:[
      {id:'functions',kind:'function',code:`metrics.code_function_references_${field}.length`,aggregation:'0'},
      {id:'file',kind:'file',code:`metrics.${field}`},
    ]},{include:['a.ts']});
    assert.deepEqual(result.functions.map(fn=>fn.score),functionScores);
    assert.equal(result.files[0].score,fileScore);
  }
});
