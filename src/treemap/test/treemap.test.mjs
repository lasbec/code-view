import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { calculateTreeMap, createTreeMap, renderTreeMap, listMetrics, colorFor } from '../src/index.mjs';
import { main, warningsPath } from '../src/cli.mjs';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'treemap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'analysis.sqlite');
  const db = new DatabaseSync(input);
  db.exec(`
    CREATE TABLE code_metadata(key TEXT,value TEXT);
    INSERT INTO code_metadata VALUES ('tsconfig','/repo/packages/app/tsconfig.json');
    CREATE TABLE code_files(id TEXT PRIMARY KEY,size_bytes INTEGER,total_lines INTEGER);
    INSERT INTO code_files VALUES ('src/a.ts',100,20),('src/b.ts',300,40),('empty.ts',0,0),('src/null.ts',NULL,10);
    CREATE TABLE code_functions(id TEXT,file_id TEXT,cyclomatic_complexity INTEGER);
    INSERT INTO code_functions VALUES ('f1','src/a.ts',8),('f2','src/a.ts',12),('f3','src/b.ts',40),('f4','src/null.ts',NULL);
    CREATE VIEW code_file_function_counts AS SELECT file_id,COUNT(*) AS function_count FROM code_functions GROUP BY file_id;
    CREATE TABLE code_parameters(id TEXT,function_id TEXT,mutation_count INTEGER);
    INSERT INTO code_parameters VALUES ('p1','f1',2),('p2','f1',3),('p3','f2',7);
    CREATE TABLE git_repositories(id INTEGER,path TEXT);
    INSERT INTO git_repositories VALUES (1,'/repo'),(2,'/other');
    CREATE TABLE git_commits(repository_id INTEGER,hash TEXT,committed_at TEXT,is_merge INTEGER);
    INSERT INTO git_commits VALUES (1,'a','2026-01-01T00:00:00Z',0),(1,'b','2026-02-01T00:00:00Z',1),(2,'x','2026-02-01T00:00:00Z',0);
    CREATE TABLE git_file_changes(repository_id INTEGER,commit_hash TEXT,position INTEGER,path TEXT,similarity INTEGER);
    INSERT INTO git_file_changes VALUES (1,'a',0,'packages/app/src/a.ts',NULL),(1,'b',0,'packages/app/src/a.ts',NULL),(1,'b',1,'packages/app/src/b.ts',NULL),(1,'a',1,'deleted.ts',NULL),(2,'x',0,'packages/app/src/a.ts',NULL);
    CREATE TABLE git_merge_conflict_files(repository_id INTEGER,commit_hash TEXT,path TEXT);
    INSERT INTO git_merge_conflict_files VALUES (1,'b','packages/app/src/a.ts');
  `);
  db.close();
  return { dir, input, bytes: readFileSync(input) };
}
const config = { scores: [
  { name: 'Complexity', metrics: [{ metric: 'code_functions.cyclomatic_complexity', min: 10, max: 30, factor: 2 }, { metric: 'code.function_count', factor: 0.5 }] },
  { name: 'Changes', metrics: [{ metric: 'git.change_count' }] },
] };

test('sums metrics before clipping, adds contributions and multiplies scores; joins paths and repositories', async t => {
  const { bytes } = fixture(t);
  const result = await calculateTreeMap(bytes, config);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.files.map(f => [f.path, f.area, f.heat]), [['packages/app/src/a.ts', 100, 42], ['packages/app/src/b.ts', 300, 40.5]]);
  assert.equal(result.tree.area, 400);
  assert.equal(result.legend.max, 42);
  assert.ok(result.diagnostics.some(d => d.code === 'missing-values'));
  assert.equal(result.diagnostics.find(d => d.code === 'nonpositive-area').paths.length, 2);
  const metrics = await listMetrics(bytes);
  assert.ok(metrics.some(m => m.metric === 'code_parameters.mutation_count'));
  assert.ok(metrics.some(m => m.metric === 'code_file_function_counts.function_count'));
  assert.ok(metrics.some(m => m.metric === 'git.conflict_count'));
});

test('avoids multiplication of joined child rows and applies date/glob filters before the legend', async t => {
  const { bytes } = fixture(t);
  const c = { area: 'code_files.total_lines', scores: [{ metrics: [{ metric: 'code_parameters.mutation_count' }] }, { metrics: [{ metric: 'git.change_count' }] }] };
  const result = await calculateTreeMap(bytes, c, { include: ['packages/**'], exclude: ['**/b.ts', '**/null.ts'], since: '2026-01-15' });
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].heat, 12);
  assert.equal(result.legend.max, 12);
  const conflict = await calculateTreeMap(bytes, { scores: [{ metrics: [{ metric: 'git.conflict_count' }] }] });
  assert.deepEqual(conflict.files.map(f => f.heat), [1, 0]);
});

test('zero scores, empty selections, fixed colors and invalid thresholds', async t => {
  const { bytes } = fixture(t);
  const zero = { scores: [{ metrics: [{ metric: 'code.function_count', min: 99 }] }] };
  const result = await calculateTreeMap(bytes, zero);
  assert.equal(result.ok, true);
  assert.equal(result.legend.max, 0);
  assert.ok(result.files.every(f => f.heat === 0 && f.color === 'rgb(34, 160, 70)'));
  assert.equal((await calculateTreeMap(bytes, config, { include: ['nothing/**'] })).ok, true);
  const legend = { min: 0, max: 100, yellowFrom: 30, redFrom: 70 };
  assert.equal(colorFor(-10, legend), 'rgb(34, 160, 70)');
  assert.equal(colorFor(30, legend), 'rgb(255, 215, 0)');
  assert.equal(colorFor(70, legend), 'rgb(225, 45, 45)');
  assert.equal(colorFor(100, legend), 'rgb(135, 55, 190)');
  assert.equal(colorFor(150, legend), colorFor(100, legend));
  assert.equal(colorFor(50, legend), 'rgb(240, 130, 23)');
  assert.equal((await calculateTreeMap(bytes, { ...config, heat: { max: 100, yellowFrom: 80, redFrom: 70 } })).ok, false);
});

test('unknown metrics, malformed inputs and score overflows return structured errors', async t => {
  const { bytes } = fixture(t);
  for (const c of [{ scores: [] }, { scores: [{ metrics: [{ metric: 'typo' }] }] }, { ...config, area: 'typo' }, { scores: [{ metrics: [{ metric: 'code.function_count', factor: -1 }] }] }, { scores: [{ metrics: [{ metric: 'code_files.size_bytes', factor: Number.MAX_VALUE }] }] }]) {
    assert.equal((await calculateTreeMap(bytes, c)).ok, false);
  }
  const bad = await calculateTreeMap(new Uint8Array([1, 2, 3]), config);
  assert.equal(bad.ok, false);
  assert.match(renderTreeMap(bad).treeMapWarningsHtml, /Fehler/);
  assert.equal((await calculateTreeMap(new Uint8Array(), config)).ok, false);
});

test('CLI writes byte-for-byte API snippets and derives warnings paths, also on fatal errors', async t => {
  const { bytes, input, dir } = fixture(t);
  const output = path.join(dir, 'nested', 'report.html');
  const expected = await createTreeMap(bytes, config);
  const cli = await main(['--input', input, '--output', output, '--config-json', JSON.stringify(config)]);
  assert.equal(cli.ok, true);
  assert.equal(readFileSync(output, 'utf8'), expected.treeMapHtml);
  assert.equal(readFileSync(warningsPath(output), 'utf8'), expected.treeMapWarningsHtml);
  assert.equal(warningsPath('report'), 'report.warnings.html');
  assert.equal((await main(['--input', input, '--output', output, '--config-json', '{bad'])).ok, false);
  assert.match(readFileSync(warningsPath(output), 'utf8'), /Fehler/);
  await assert.rejects(main(['--input', input, '--output', input, '--config-json', JSON.stringify(config)]), /nicht überschreiben/);
  assert.deepEqual(readFileSync(input), bytes);
});

test('safe standalone snippets coexist, support navigation and escape database text', async t => {
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const { bytes } = fixture(t);
  const model = await calculateTreeMap(bytes, config);
  const hostile = '</script><img src=x onerror="window.hacked=true">';
  model.tree.children[0].name = hostile;
  model.diagnostics.push({ severity: 'warning', message: hostile, paths: [hostile] });
  const html = renderTreeMap(model);
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e));
  const dom = new JSDOM(html.treeMapHtml + html.treeMapHtml + html.treeMapWarningsHtml, { runScripts: 'dangerously', virtualConsole: vc });
  t.after(() => dom.window.close());
  assert.equal(dom.window.hacked, undefined);
  assert.equal(dom.window.document.querySelector('img'), null);
  const hosts = dom.window.document.querySelectorAll('.code-view-treemap');
  assert.equal(hosts.length, 2);
  const shadow = hosts[0].shadowRoot;
  assert.ok([...shadow.querySelectorAll('.tile')].some(tile => tile.textContent === 'a.ts'));
  assert.ok([...shadow.querySelectorAll('.tile')].some(tile => tile.textContent === 'b.ts'));
  assert.equal(shadow.querySelectorAll('nav button').length, 1);
  shadow.querySelector('.tile').click();
  assert.ok(shadow.querySelectorAll('nav button').length > 1);
  assert.equal(hosts[1].shadowRoot.querySelectorAll('nav button').length, 1);
  shadow.querySelector('nav button').click();
  assert.equal(shadow.querySelectorAll('nav button').length, 1);
  [...shadow.querySelectorAll('.tile')].find(tile => tile.textContent === 'src/').click();
  assert.equal(shadow.querySelectorAll('nav button').length, 4);
  assert.equal(shadow.querySelectorAll('.tile').length, 2);
  assert.deepEqual(errors, []);
});

test('bundled browser API reads SQLite bytes without filesystem or network and matches Node', async t => {
  const { buildBrowser } = await import('../build.mjs');
  const { JSDOM } = await import('jsdom');
  const { bytes } = fixture(t);
  const bundle = await buildBrowser({ format: 'iife', globalName: 'Treemap', write: false });
  const dom = new JSDOM('', { runScripts: 'dangerously' }); t.after(() => dom.window.close());
  // Real browsers expose these globals; jsdom does not supply them.
  dom.window.TextDecoder = TextDecoder; dom.window.TextEncoder = TextEncoder;
  dom.window.eval(bundle.outputFiles[0].text);
  const browserBytes = new dom.window.Uint8Array(bytes);
  const snippets = await dom.window.Treemap.createTreeMap(browserBytes, JSON.parse(JSON.stringify(config)));
  assert.deepEqual(JSON.parse(JSON.stringify(snippets)), await createTreeMap(bytes, config));
});

test('three scores multiply; NULL stays zero with positive area; views can be scored', async t => {
  const { bytes } = fixture(t);
  const result = await calculateTreeMap(bytes, { area: 'code_files.total_lines', scores: [
    { metrics: [{ metric: 'code_files.total_lines' }] },
    { metrics: [{ metric: 'code_file_function_counts.function_count' }] },
    { metrics: [{ metric: 'code_functions.cyclomatic_complexity' }] },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.files.find(f => f.id === 'src/a.ts').heat, 800);
  assert.equal(result.files.find(f => f.id === 'src/null.ts').heat, 0);
});

test('moved metadata requires explicit path mapping and supports Windows provenance', async t => {
  const { input } = fixture(t);
  const db = new DatabaseSync(input);
  db.exec("UPDATE code_metadata SET value='C:\\moved\\packages\\app\\tsconfig.json'");
  db.close();
  const bytes = readFileSync(input);
  assert.equal((await calculateTreeMap(bytes, config)).ok, false);
  const mapped = await calculateTreeMap(bytes, config, { repository: '/repo', codePrefix: 'packages/app' });
  assert.equal(mapped.ok, true);
  assert.equal(mapped.files[0].heat, 42);
});

test('accepts databases larger than the SQLite engine initial heap', async t => {
  const { input } = fixture(t);
  const db = new DatabaseSync(input);
  db.exec('CREATE TABLE unrelated_payload(value BLOB); INSERT INTO unrelated_payload VALUES (zeroblob(24000000))');
  db.close();
  const result = await calculateTreeMap(readFileSync(input), config);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.files[0].heat, 42);
});
