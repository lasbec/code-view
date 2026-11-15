import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTreeMap, createTreeMap, colorFor, listMetrics } from '../src/index.mjs';
import { fixture, definition } from '../../score-code/test/fixture.mjs';
const config = { ...definition, area:'code_files.size_bytes',functionArea:'code_functions.exclusive_size_bytes' };
test('treemap uses the shared formula scores while area remains independent', async t => {
  const {db,bytes}=fixture(t); db.close();
  const result=await calculateTreeMap(bytes(),config,{showFunctions:true});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.deepEqual(result.files.map(f=>[f.id,f.heat]),[['a.ts',57],['b.ts',17],['empty.ts',0]]);
  assert.equal(result.tree.area,310);
  const file=result.files[0];assert.equal(file.children[0].heat,9);
  assert.ok(file.children.some(fn=>fn.kind==='outside'));
  assert.equal(file.children.reduce((sum,fn)=>sum+fn.area,0),file.area);
  assert.equal(result.legend.max,57);
});
test('path filters and Git date bounds affect the same scored population',async t=>{
  const {db,bytes}=fixture(t);db.close();
  const result=await calculateTreeMap(bytes(),config,{include:['a.ts'],since:'2026-01-01T00:00:00Z'});
  assert.equal(result.ok,true);assert.equal(result.files.length,1);assert.equal(result.files[0].heat,47);
});
test('negative and failed scores remain visible with an appropriate heat scale',async t=>{
  const {db,bytes}=fixture(t);db.close();
  const negative=await calculateTreeMap(bytes(),{...config,fields:[{id:'negative',kind:'file',code:'-metrics.total_lines'}]});
  assert.equal(negative.ok,true);assert.equal(negative.legend.min,-30);assert.equal(negative.files[0].heat,-20);
  const failed=await calculateTreeMap(bytes(),{...config,fields:[{id:'bad',kind:'file',code:'1/0'}]});
  assert.equal(failed.ok,true);assert.equal(failed.files.length,3);assert.equal(failed.files[0].heat,null);assert.equal(failed.files[0].color,'#c9d0d8');
  assert.ok(failed.diagnostics.some(d=>d.code==='score-error'));
});
test('heat changes affect presentation without changing contribution values',async t=>{
  const {db,bytes}=fixture(t);db.close();
  const result=await calculateTreeMap(bytes(),{...config,heat:{min:0,yellowFrom:10,redFrom:40,max:100}});
  assert.equal(result.ok,true);assert.equal(result.legend.max,100);assert.equal(result.files[0].heat,57);
  assert.equal(colorFor(0,result.legend),'rgb(34, 160, 70)');
});
test('catalog and standalone snippets expose metrics and explain calculation failures',async t=>{
  const {db,bytes}=fixture(t);db.close();
  const metrics=await listMetrics(bytes());assert.ok(metrics.some(m=>m.metric==='code_functions.cyclomatic_complexity'));
  const snippet=await createTreeMap(bytes(),config);assert.match(snippet.treeMapHtml,/a.ts/);assert.match(snippet.treeMapHtml,/Churn/);
  const bad=await calculateTreeMap(new Uint8Array(),config);assert.equal(bad.ok,false);assert.ok(bad.diagnostics.length);
});

test('standalone snippets escape database paths and coexist without leaking scripts',async t=>{
  const {db,bytes}=fixture(t);
  db.prepare('UPDATE code_files SET id=? WHERE id=?').run('evil</script><script>window.poison=1</script>.ts','empty.ts');db.close();
  const snippet=await createTreeMap(bytes(),config);
  assert.doesNotMatch(snippet.treeMapHtml,/<script>window\.poison/);
  assert.match(snippet.treeMapHtml,/\\u003c/);
});
test('repository mapping and author identities preserve scoped attribution',async t=>{
  const {db,bytes}=fixture(t);
  db.exec("UPDATE code_metadata SET value='/repo/packages/app/tsconfig.json'; UPDATE git_file_changes SET path='packages/app/' || path;");db.close();
  const result=await calculateTreeMap(bytes(),config,{since:'2026-01-01T00:00:00Z',authorIdentities:[{name:'Canonical',email:'canonical@example.com',aliases:['demo@example.com']}]});
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  assert.equal(result.files[0].path,'packages/app/a.ts');assert.equal(result.files[0].heat,47);
  assert.deepEqual(result.files[0].topAuthors,[{name:'Canonical',email:'canonical@example.com',commits:1}]);
});
test('unknown size metrics and invalid identities return structured errors',async t=>{
  const {db,bytes}=fixture(t);db.close();
  for(const [display,options] of [[{...config,area:'unknown'},{}],[config,{authorIdentities:[{name:'Invalid',email:'bad'}]}]]) {
    const result=await calculateTreeMap(bytes(),display,options);assert.equal(result.ok,false);assert.equal(result.diagnostics.at(-1).severity,'error');
  }
});
test('zero-area files remain available to list consumers without entering ordinary map layout',async t=>{
  const {db,bytes}=fixture(t);db.exec("UPDATE code_files SET size_bytes=0 WHERE id='empty.ts'");db.close();
  const ordinary=await calculateTreeMap(bytes(),config), listing=await calculateTreeMap(bytes(),config,{includeZeroArea:true});
  assert.equal(ordinary.files.length,2);assert.equal(listing.files.length,3);
  assert.equal(listing.files.find(f=>f.id==='empty.ts').heat,0);
});
test('CLI persists scores, writes API-equivalent snippets, and protects input paths',async t=>{
  const {db,path,bytes,directory}=fixture(t);db.close();
  const {main,warningsPath}=await import('../src/cli.mjs');
  const {readFileSync}=await import('node:fs');
  const {DatabaseSync}=await import('node:sqlite');
  const output=directory+'/report.html';
  const result=await main(['--input',path,'--output',output,'--config-json',JSON.stringify(config)]);
  assert.equal(result.ok,true);assert.equal(readFileSync(output,'utf8'),(await createTreeMap(bytes(),config)).treeMapHtml);
  assert.ok(readFileSync(warningsPath(output),'utf8'));
  const stored=new DatabaseSync(path);assert.equal(stored.prepare('SELECT COUNT(*) AS n FROM score_runs').get().n,1);stored.close();
  await assert.rejects(main(['--input',path,'--output',path,'--config-json',JSON.stringify(config)]));
});
test('browser bundle exposes rendering without embedding server-side formula execution',async()=>{
  const {buildBrowser}=await import('../build.mjs');
  const bundle=await buildBrowser({write:false});
  const source=bundle.outputFiles[0].text;
  assert.doesNotMatch(source,/node:vm|createEvaluator|calculateScores|node:sqlite/);
  assert.match(source,/renderTreeMap/);
});
