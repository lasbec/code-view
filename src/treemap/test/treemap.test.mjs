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
const config = { operation: 'product', scores: [
  { name: 'Complexity', normalize: false, max: 40, metrics: [{ metric: 'code_functions.cyclomatic_complexity', min: 10, factor: 2 }, { metric: 'code_functions.count', factor: 0.5 }] },
  { name: 'Changes', normalize: false, metrics: [{ metric: 'git_file_changes.count' }] },
] };

test('thresholds individual measurements, caps groups and combines scores; joins paths and repositories', async t => {
  const { bytes } = fixture(t);
  const result = await calculateTreeMap(bytes, config);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.files.map(f => [f.path, f.area, f.heat]), [['packages/app/src/a.ts', 100, 10], ['packages/app/src/b.ts', 300, 40]]);
  assert.equal(result.tree.area, 400);
  assert.equal(result.legend.max, 40);
  assert.ok(result.diagnostics.some(d => d.code === 'missing-values'));
  assert.equal(result.diagnostics.find(d => d.code === 'nonpositive-area').paths.length, 2);
  const metrics = await listMetrics(bytes);
  assert.ok(metrics.some(m => m.metric === 'code_parameters.mutation_count'));
  assert.ok(metrics.some(m => m.metric === 'code_functions.count'));
  assert.ok(metrics.some(m => m.metric === 'git_merge_conflict_files.count'));
});

test('avoids multiplication of joined child rows and applies date/glob filters before the legend', async t => {
  const { bytes } = fixture(t);
  const c = { operation: 'product', area: 'code_files.total_lines', scores: [{ normalize: false, metrics: [{ metric: 'code_parameters.mutation_count' }] }, { normalize: false, metrics: [{ metric: 'git_file_changes.count' }] }] };
  const result = await calculateTreeMap(bytes, c, { include: ['packages/**'], exclude: ['**/b.ts', '**/null.ts'], since: '2026-01-15' });
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].heat, 12);
  assert.equal(result.legend.max, 12);
  const conflict = await calculateTreeMap(bytes, { scores: [{ normalize: false, metrics: [{ metric: 'git_merge_conflict_files.count' }] }] });
  assert.deepEqual(conflict.files.map(f => f.heat), [1, 0]);
});

test('zero scores, empty selections, fixed colors and invalid thresholds', async t => {
  const { bytes } = fixture(t);
  const zero = { scores: [{ normalize: false, metrics: [{ metric: 'code_functions.count', min: 99 }] }] };
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
  for (const c of [{ scores: [] }, { scores: [{ normalize: false, metrics: [{ metric: 'typo' }] }] }, { ...config, area: 'typo' }, { scores: [{ normalize: false, metrics: [{ metric: 'code_functions.count', factor: -1 }] }] }, { scores: [{ normalize: false, metrics: [{ metric: 'code_files.size_bytes', factor: Number.MAX_VALUE }] }] }]) {
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

test('three raw groups can multiply; NULL scores stay zero with positive area', async t => {
  const { bytes } = fixture(t);
  const result = await calculateTreeMap(bytes, { operation: 'product', area: 'code_files.total_lines', scores: [
    { normalize: false, metrics: [{ metric: 'code_files.total_lines' }] },
    { normalize: false, metrics: [{ metric: 'code_functions.count' }] },
    { normalize: false, metrics: [{ metric: 'code_functions.cyclomatic_complexity' }] },
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
  assert.equal(mapped.files[0].heat, 10);
});

test('accepts databases larger than the SQLite engine initial heap', async t => {
  const { input } = fixture(t);
  const db = new DatabaseSync(input);
  db.exec('CREATE TABLE unrelated_payload(value BLOB); INSERT INTO unrelated_payload VALUES (zeroblob(24000000))');
  db.close();
  const result = await calculateTreeMap(readFileSync(input), config);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.files[0].heat, 10);
});

test('file authors count distinct commits, respect repository/date mapping, and render safe horizontal details', async t => {
  const { input } = fixture(t), db = new DatabaseSync(input);
  db.exec(`ALTER TABLE git_commits ADD COLUMN author_name TEXT;
    ALTER TABLE git_commits ADD COLUMN author_email TEXT;
    UPDATE git_commits SET author_name='Alice',author_email='alice@example.test' WHERE hash='a';
    UPDATE git_commits SET author_name='Bob',author_email='bob@example.test' WHERE hash='b';
    UPDATE git_commits SET author_name='Other repo',author_email='other@example.test' WHERE hash='x';
    INSERT INTO git_commits VALUES (1,'c','2026-03-01T00:00:00Z',0,'Alice renamed','alice@example.test'),
      (1,'d','2026-04-01T00:00:00Z',0,'<img src=x onerror=alert(1)>','third@example.test');
    INSERT INTO git_file_changes VALUES (1,'c',0,'packages/app/src/a.ts',NULL),
      (1,'c',1,'packages/app/src/a.ts',NULL),(1,'d',0,'packages/app/src/a.ts',NULL);`);
  db.close();
  const bytes = readFileSync(input), result = await calculateTreeMap(bytes, config);
  assert.equal(result.ok, true);
  assert.deepEqual(result.files.find(f => f.path.endsWith('/a.ts')).topAuthors, [
    { name: 'Alice', email: 'alice@example.test', commits: 2 }, { name: '<img src=x onerror=alert(1)>', email: 'third@example.test', commits: 1 },
  ]);
  assert.deepEqual(result.files.find(f => f.path.endsWith('/a.ts')).topMergeAuthors, [
    { name: 'Bob', email: 'bob@example.test', merges: 1 },
  ]);
  const filtered = await calculateTreeMap(bytes, config, { since: '2026-03-15', until: '2026-05-01' });
  assert.deepEqual(filtered.files.find(f => f.path.endsWith('/a.ts')).topAuthors, [{name:'<img src=x onerror=alert(1)>',email:'third@example.test',commits:1}]);
  assert.deepEqual(filtered.files.find(f => f.path.endsWith('/b.ts')).topAuthors, []);
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(renderTreeMap(filtered).treeMapHtml, { runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const shadow = dom.window.document.querySelector('.code-view-treemap').shadowRoot;
  [...shadow.querySelectorAll('.tile')].find(tile => tile.textContent === 'a.ts').click();
  assert.ok(shadow.querySelector('.detail-grid'));
  assert.match(shadow.querySelector('.detail').textContent, /Häufigste Autoren/);
  assert.match(shadow.querySelector('.detail').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(shadow.querySelector('.detail img'), null);
  // Hovering a neighboring tile must not replace details of the clicked file.
  [...shadow.querySelectorAll('.tile')].find(tile => tile.textContent === 'b.ts').dispatchEvent(new dom.window.Event('mouseenter'));
  assert.match(shadow.querySelector('.detail-path').textContent, /a.ts$/);
});

test('older databases without author metadata remain usable', async t => {
  const { bytes } = fixture(t);
  const result = await calculateTreeMap(bytes, config);
  assert.equal(result.ok, true);
  assert.ok(result.files.every(file => file.topAuthors === null));
  assert.ok(result.files.every(file => file.topMergeAuthors === null));
});

test('repository-root tsconfig maps authors and Git metrics without requiring a date filter', async t => {
  const { input } = fixture(t), db = new DatabaseSync(input);
  db.exec(`UPDATE code_metadata SET value='/repo/tsconfig.json' WHERE key='tsconfig';
    UPDATE git_file_changes SET path=REPLACE(path,'packages/app/','');
    ALTER TABLE git_commits ADD COLUMN author_name TEXT;
    ALTER TABLE git_commits ADD COLUMN author_email TEXT;
    UPDATE git_commits SET author_name='Alice', author_email='alice@example.test';`);
  db.close();
  const result = await calculateTreeMap(readFileSync(input), config);
  assert.equal(result.ok, true);
  const file = result.files.find(file => file.path === 'src/a.ts');
  assert.ok(file, 'A repository-relative path must not acquire a leading slash.');
  assert.deepEqual(file.topAuthors, [{ name:'Alice', email:'alice@example.test', commits:1 }]);
  assert.deepEqual(file.topMergeAuthors, [{ name:'Alice', email:'alice@example.test', merges:1 }]);
  assert.equal(file.metrics['git_file_changes.count'], 2);
  const filtered = await calculateTreeMap(readFileSync(input), config, { exclude: ['/src/b.ts'] });
  assert.ok(!filtered.files.some(file => file.path === 'src/b.ts'));
});

test('repeated merges do not displace code authors and explicit identities combine email aliases', async t => {
  const { input } = fixture(t), db = new DatabaseSync(input);
  db.exec(`ALTER TABLE git_commits ADD COLUMN author_name TEXT;
    ALTER TABLE git_commits ADD COLUMN author_email TEXT;
    UPDATE git_commits SET author_name='TN', author_email='thomas@example.test' WHERE hash='a';
    UPDATE git_commits SET author_name='Patry', author_email='patry@work.test' WHERE hash='b';
    INSERT INTO git_commits VALUES
      (1,'c','2026-03-01T00:00:00Z',0,'TN','thomas@example.test'),
      (1,'m2','2026-03-02T00:00:00Z',1,'Patry','patry@work.test'),
      (1,'m3','2026-03-03T00:00:00Z',1,'Patry','patry@work.test'),
      (1,'m4','2026-03-04T00:00:00Z',1,'Patrycja Kupiec','patry@private.test'),
      (1,'m5','2026-03-05T00:00:00Z',1,'Patrycja Kupiec','patry@private.test'),
      (1,'m6','2026-03-06T00:00:00Z',1,'Patrycja Kupiec','patry@private.test');
    INSERT INTO git_file_changes SELECT 1,hash,10,'packages/app/src/a.ts',NULL
      FROM git_commits WHERE repository_id=1 AND hash NOT IN ('a','b');
    INSERT INTO git_file_changes VALUES (1,'m6',11,'packages/app/src/a.ts',NULL);`);
  db.close();
  const bytes = readFileSync(input);
  const authorIdentities = [{ name: 'Patrycja Kupiec', email: 'patry@work.test', aliases: ['patry@private.test'] }];
  const result = await calculateTreeMap(bytes, config, { authorIdentities });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const file = result.files.find(f => f.path.endsWith('/a.ts'));
  assert.deepEqual(file.topAuthors, [{ name: 'TN', email: 'thomas@example.test', commits: 2 }]);
  assert.deepEqual(file.topMergeAuthors, [{ name: 'Patrycja Kupiec', email: 'patry@work.test', merges: 6 }]);
  assert.equal(file.metrics['git_file_changes.count'], 9, 'Existing metrics still include all change rows.');
  const filtered = await calculateTreeMap(bytes, config, { authorIdentities, since: '2026-03-04', until: '2026-03-06' });
  const filteredFile = filtered.files.find(f => f.path.endsWith('/a.ts'));
  assert.deepEqual(filteredFile.topAuthors, []);
  assert.deepEqual(filteredFile.topMergeAuthors, [{ name: 'Patrycja Kupiec', email: 'patry@work.test', merges: 3 }]);
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(renderTreeMap(result).treeMapHtml, { runScripts: 'dangerously' });
  t.after(() => dom.window.close());
  const shadow = dom.window.document.querySelector('.code-view-treemap').shadowRoot;
  [...shadow.querySelectorAll('.tile')].find(tile => tile.textContent === 'a.ts').click();
  const sections = [...shadow.querySelectorAll('.detail section')];
  const changes = sections.find(s => s.querySelector('h3')?.textContent.includes('Änderungscommits'));
  const merges = sections.find(s => s.querySelector('h3')?.textContent.includes('Merge-Autoren'));
  assert.match(changes.textContent, /TN2/);
  assert.doesNotMatch(changes.textContent, /Patry/);
  assert.match(merges.textContent, /Patrycja Kupiec6/);
});

test('author aliases combine regular commits without merging unrelated authors with the same name', async t => {
  const { input } = fixture(t), db = new DatabaseSync(input);
  db.exec(`ALTER TABLE git_commits ADD COLUMN author_name TEXT;
    ALTER TABLE git_commits ADD COLUMN author_email TEXT;
    UPDATE git_commits SET author_name='Alice',author_email='alice@work.test';
    INSERT INTO git_commits VALUES
      (1,'c','2026-03-01T00:00:00Z',0,'Alice',' ALICE@PRIVATE.TEST '),
      (1,'d','2026-03-02T00:00:00Z',0,'Alice','unrelated@example.test');
    INSERT INTO git_file_changes VALUES (1,'c',0,'packages/app/src/a.ts',NULL),
      (1,'d',0,'packages/app/src/a.ts',NULL);`);
  db.close();
  const result = await calculateTreeMap(readFileSync(input), config, {
    authorIdentities: [{ name: 'Alice Example', email: 'alice@work.test', aliases: ['alice@private.test'] }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.files.find(f => f.path.endsWith('/a.ts')).topAuthors, [
    { name: 'Alice Example', email: 'alice@work.test', commits: 2 },
    { name: 'Alice', email: 'unrelated@example.test', commits: 1 },
  ]);
  const identities = path.join(path.dirname(input), 'identities.json');
  const output = path.join(path.dirname(input), 'authors.html');
  writeFileSync(identities, JSON.stringify([{ name: 'Alice Example', email: 'alice@work.test', aliases: ['alice@private.test'] }]));
  const cli = await main(['--input', input, '--output', output, '--config-json', JSON.stringify(config), '--author-identities', identities]);
  assert.equal(cli.ok, true);
  assert.equal(readFileSync(output, 'utf8'), renderTreeMap(result).treeMapHtml);
  await assert.rejects(main(['--input', input, '--output', identities, '--config-json', JSON.stringify(config), '--author-identities', identities]), /nicht überschreiben/);
});

test('ambiguous author identities fail rather than silently misattribute commits', async t => {
  const { bytes } = fixture(t);
  const result = await calculateTreeMap(bytes, config, { authorIdentities: [
    { name: 'Alice', email: 'alice@work.test', aliases: ['alias@work.test'] },
    { name: 'Bob', email: 'ALIAS@WORK.TEST' },
  ] });
  assert.equal(result.ok, false);
  assert.match(result.diagnostics[0].message, /belongs to more than one entry/);
});

test('group normalization, capping and every combination operation use displayed files only', async t => {
  const { input } = fixture(t), db = new DatabaseSync(input);
  db.exec("INSERT INTO code_functions VALUES ('hidden','empty.ts',10000)"); db.close();
  const bytes = readFileSync(input);
  const group = (normalize, max) => ({ name:'Complexity', normalize, ...(max === undefined ? {} : {max}), metrics:[{metric:'code_functions.cyclomatic_complexity', min:10}] });
  const normalized = await calculateTreeMap(bytes, {scores:[group(true)]});
  assert.equal(normalized.ok,true);
  assert.deepEqual(normalized.files.map(f=>f.scores[0].raw),[2,30]);
  assert.equal(normalized.files[0].scores[0].max,30);
  assert.equal(normalized.files[1].heat,100);
  assert.equal(normalized.legend.max,100);
  const raw = await calculateTreeMap(bytes,{scores:[group(false)]});
  assert.equal(raw.legend.max,30, 'Omitted files must not affect the legend.');
  for(const normalize of [true,false]) {
    const capped = await calculateTreeMap(bytes,{scores:[group(normalize,20)],heat:{max:250}});
    assert.equal(capped.files[1].heat,normalize ? 100 : 20);
    assert.equal(capped.legend.max,250);
  }
  const scores=[group(false,20),{normalize:false,metrics:[{metric:'code_files.total_lines'}]}];
  for(const [operation,quantile,expected] of [['sum',50,60],['product',50,800],['min',50,20],['max',50,40],['quantile',25,25],['quantile',0,20],['quantile',100,40]]) {
    const result=await calculateTreeMap(bytes,{scores,operation,quantile});
    assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
    assert.equal(result.files[1].heat,expected);
  }
  const filtered=await calculateTreeMap(bytes,{scores:[group(true)]},{exclude:['**/b.ts']});
  assert.equal(filtered.files[0].heat,100);
  assert.equal(filtered.files[0].scores[0].max,2);
});

test('file aggregations use only strictly exceeding measurements and linearly interpolate quantiles',async t=>{
  const {input}=fixture(t),db=new DatabaseSync(input);
  db.exec("DELETE FROM code_functions; INSERT INTO code_functions VALUES ('f1','src/a.ts',5),('f2','src/a.ts',12),('f3','src/a.ts',20),('boundary','src/a.ts',10)");db.close();
  for(const [aggregation,quantile,expected] of [['sum',50,12],['min',50,2],['max',50,10],['count',50,2],['quantile',25,4],['quantile',0,2],['quantile',100,10]]) {
    const r=await calculateTreeMap(readFileSync(input),{scores:[{normalize:false,metrics:[{metric:'code_functions.cyclomatic_complexity',min:10,aggregation,quantile}]}]});
    assert.equal(r.ok,true,JSON.stringify(r.diagnostics));
    assert.equal(r.files[0].heat,expected);
    assert.equal(r.files[1].heat,0);
  }
});

test('catalog excludes identifiers, duplicates and meaningless sums; invalid configuration is rejected',async t=>{
  const {bytes}=fixture(t),catalog=await listMetrics(bytes);
  assert.equal(new Set(catalog.map(m=>m.metric)).size,catalog.length);
  assert.ok(catalog.every(m=>m.label && m.aggregations.length));
  for(const id of ['git_file_changes.position','git_file_changes.similarity','code_file_function_counts.function_count','code.function_count','code_functions.line','code_diagnostics.code']) {
    assert.ok(!catalog.some(m=>m.metric===id));
    assert.equal((await calculateTreeMap(bytes,{scores:[{metrics:[{metric:id}]}]})).ok,false);
  }
  for(const extra of [{operation:'average'},{quantile:101},{quantile:-1},{scores:[{max:0,metrics:[{metric:'code_functions.count'}]}]},{scores:[{normalize:'yes',metrics:[{metric:'code_functions.count'}]}]},{scores:[{metrics:[{metric:'code_functions.count',aggregation:'max'}]}]},{scores:[{metrics:[{metric:'code_functions.cyclomatic_complexity',quantile:101}]}]}]) {
    assert.equal((await calculateTreeMap(bytes,{scores:[{metrics:[{metric:'code_functions.count'}]}],...extra})).ok,false);
  }
});

test('conflict paths count even when the merge result equals the first parent; repository and date filters still apply',async t=>{
  const {input}=fixture(t),db=new DatabaseSync(input);
  db.exec(`DELETE FROM git_file_changes WHERE commit_hash='b';
    CREATE TABLE git_merge_conflicts(repository_id INTEGER,commit_hash TEXT,position INTEGER,conflict_type TEXT);
    CREATE TABLE git_merge_conflict_paths(repository_id INTEGER,commit_hash TEXT,conflict_position INTEGER,path TEXT);
    INSERT INTO git_merge_conflicts VALUES(1,'b',0,'CONFLICT (content)'),(2,'x',0,'CONFLICT (content)');
    INSERT INTO git_merge_conflict_paths VALUES(1,'b',0,'packages/app/src/a.ts'),(2,'x',0,'packages/app/src/a.ts');
    INSERT INTO git_merge_conflict_files VALUES(2,'x','packages/app/src/a.ts');`);db.close();
  for(const metric of ['git_merge_conflict_files.count','git_merge_conflicts.count']) {
    const config={scores:[{normalize:false,metrics:[{metric}]}]};
    const r=await calculateTreeMap(readFileSync(input),config);
    assert.equal(r.ok,true,JSON.stringify(r.diagnostics));assert.equal(r.files[0].heat,1);
    const filtered=await calculateTreeMap(readFileSync(input),config,{since:'2026-03-01'});
    assert.equal(filtered.files[0].heat,0);
  }
});

function functionFixture(t) {
 const data=fixture(t),db=new DatabaseSync(data.input);
 db.exec(`ALTER TABLE code_files ADD COLUMN outside_size_bytes INTEGER;
 UPDATE code_files SET outside_size_bytes=size_bytes;
 UPDATE code_files SET outside_size_bytes=50 WHERE id='src/a.ts';
 UPDATE code_files SET outside_size_bytes=200 WHERE id='src/b.ts';
 ALTER TABLE code_functions ADD COLUMN exclusive_size_bytes INTEGER DEFAULT 20;
 ALTER TABLE code_functions ADD COLUMN exclusive_effective_lines INTEGER DEFAULT 2;
 ALTER TABLE code_functions ADD COLUMN name TEXT DEFAULT 'example';
 ALTER TABLE code_functions ADD COLUMN kind TEXT DEFAULT 'ArrowFunction';
 ALTER TABLE code_functions ADD COLUMN line INTEGER DEFAULT 2;
 ALTER TABLE code_functions ADD COLUMN column INTEGER DEFAULT 1;
 ALTER TABLE code_functions ADD COLUMN end_line INTEGER DEFAULT 3;
 UPDATE code_functions SET exclusive_size_bytes=30,line=5 WHERE id='f2';
 UPDATE code_functions SET exclusive_size_bytes=100 WHERE id='f3';`);db.close();
 return {...data,bytes:readFileSync(data.input)};
}

test('function view preserves file areas, distributes exclusive sizes and shares normalization with file borders',async t=>{
 const {bytes}=functionFixture(t);
 const config={scores:[{metrics:[{metric:'code_functions.cyclomatic_complexity',aggregation:'min'}]}]};
 const r=await calculateTreeMap(bytes,config,{showFunctions:true,include:['**/a.ts']});
 assert.equal(r.ok,true,JSON.stringify(r.diagnostics));
 const file=r.files[0],functions=file.children.filter(n=>n.kind==='function');
 assert.equal(file.area,100);assert.deepEqual(file.children.map(n=>n.area),[20,30,50]);
 assert.equal(file.children.reduce((sum,n)=>sum+n.area,0),file.area);
 assert.equal(file.scores[0].max,12,'Function score above aggregated file score must enter the shared maximum.');
 assert.equal(file.heat,8/12*100);assert.equal(functions[1].heat,100);
 assert.equal(file.children[2].heat,null);
 const altered=await calculateTreeMap(bytes,{...config,functionArea:'code_functions.exclusive_effective_lines'},{showFunctions:true,include:['**/a.ts']});
 assert.deepEqual(altered.files[0].children.map(n=>n.area),[25,25,50]);
 const {JSDOM}=await import('jsdom');
 const dom=new JSDOM(renderTreeMap(r).treeMapHtml,{runScripts:'dangerously'});t.after(()=>dom.window.close());
 const shadow=dom.window.document.querySelector('.code-view-treemap').shadowRoot;
 const border=shadow.querySelector('.file-frame');assert.ok(border);assert.equal(border.style.borderTopColor,file.color);
 const tile=[...shadow.querySelectorAll('.tile')].find(tile=>tile.textContent==='example (5:1)');assert.ok(tile);tile.click();
 assert.match(shadow.querySelector('.detail').textContent,/Raw 12/);
 assert.match(shadow.querySelector('.detail').textContent,/line 5:1/);
 border.click();assert.ok(shadow.querySelectorAll('nav button').length>1);
});

test('function scores exclude file-only metrics and empty groups, support zero-size fallback and neutral scores',async t=>{
 const {input,bytes}=functionFixture(t);
 const r=await calculateTreeMap(bytes,{operation:'product',scores:[{normalize:false,metrics:[{metric:'code_functions.cyclomatic_complexity',min:10}]},{normalize:false,metrics:[{metric:'git_file_changes.count'}]}]},{showFunctions:true});
 assert.equal(r.ok,true,JSON.stringify(r.diagnostics));
 const fn=r.files[0].children.find(n=>n.id==='f2');assert.equal(fn.heat,2);assert.equal(fn.scores.length,1);assert.equal(fn.scores[0].contributions[0].rawValue,12);
 const db=new DatabaseSync(input);db.exec("UPDATE code_functions SET cyclomatic_complexity=0 WHERE id='f1'");
 const mixed=await calculateTreeMap(readFileSync(input),{functionArea:'code_functions.cyclomatic_complexity',scores:[{metrics:[{metric:'git_file_changes.count'}]}]},{showFunctions:true});
 assert.equal(mixed.ok,true);assert.ok(mixed.files.find(f=>f.id==='src/a.ts').children.filter(n=>n.kind==='function').every(n=>n.area>0));
 db.exec("UPDATE code_functions SET cyclomatic_complexity=0; INSERT INTO code_files VALUES('plain.ts',100,10,100)");db.close();
 const zero=await calculateTreeMap(readFileSync(input),{functionArea:'code_functions.cyclomatic_complexity',scores:[{metrics:[{metric:'git_file_changes.count'}]}]},{showFunctions:true});
 assert.equal(zero.ok,true,JSON.stringify(zero.diagnostics));
 const functions=zero.files.find(f=>f.id==='src/a.ts').children.filter(n=>n.kind==='function');assert.ok(functions.every(n=>n.area>0&&n.heat===null));
 assert.deepEqual(functions.map(n=>n.area),[20,30]);
 assert.equal(zero.files.find(f=>f.id==='plain.ts').children[0].name,'Outside functions');
 const legacy=fixture(t);
 assert.equal((await calculateTreeMap(legacy.bytes,config)).ok,true);
 const old=await calculateTreeMap(legacy.bytes,config,{showFunctions:true});assert.equal(old.ok,false);assert.match(old.diagnostics.find(d=>d.severity==='error').message,/new inspection run/);
});

test('list scoring can include zero-area files without changing ordinary treemap omission', async t => {
  const {bytes}=fixture(t);
  const ordinary=await calculateTreeMap(bytes,config);
  const all=await calculateTreeMap(bytes,config,{includeZeroArea:true});
  assert.equal(all.ok,true,JSON.stringify(all.diagnostics));
  assert.equal(ordinary.files.length,2);assert.equal(all.files.length,4);
  assert.ok(all.files.some(file=>file.id==='empty.ts' && file.area===0));
  assert.equal((await calculateTreeMap(bytes,config,{includeZeroArea:'yes'})).ok,false);
});
