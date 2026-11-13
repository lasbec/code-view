import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProject } from '../src/project.mjs';
import { fingerprints } from '../src/incremental.mjs';

test('fingerprinting reads a shared compiler program once and retains dependency invalidation', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fingerprints-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({ compilerOptions: { noLib: true }, include: ['*.ts'] }));
  writeFileSync(path.join(dir, 'a.ts'), "import { b } from './b'; export const a = b;");
  writeFileSync(path.join(dir, 'b.ts'), 'export const b = 1;');
  writeFileSync(path.join(dir, 'global.ts'), 'declare const globalValue: number;');
  const project = loadProject(config);
  const program = project.files[0].program;
  const original = program.getSourceFiles.bind(program);
  let reads = 0;
  program.getSourceFiles = () => { reads++; return original(); };
  const before = fingerprints(project);
  assert.equal(reads, 1, 'Rebuild dependency metadata once per compiler program, not once per file.');
  writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;');
  const after = fingerprints(loadProject(config));
  assert.notEqual(before.get('a.ts'), after.get('a.ts'));
  assert.notEqual(before.get('b.ts'), after.get('b.ts'));
  assert.equal(before.get('global.ts'), after.get('global.ts'));
  writeFileSync(path.join(dir, 'global.ts'), 'declare const globalValue: string;');
  const globalChanged = fingerprints(loadProject(config));
  for (const [file, digest] of after) assert.notEqual(globalChanged.get(file), digest);
});

test('preparation reports indexed files before the completed-file pass starts', async t => {
  const { analyze } = await import('../src/analyze.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'index-progress-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true }, include: ['*.ts'] }));
  writeFileSync(path.join(dir, 'a.ts'), 'export function a() { return 1; }');
  writeFileSync(path.join(dir, 'b.ts'), 'export function b() { return 2; }');
  const project = loadProject(path.join(dir, 'tsconfig.json')), events = [];
  analyze(project, undefined, undefined,
    (_, file) => events.push(['completed', file.id]),
    (count, total) => events.push(['indexed', count, total]),
    () => events.push(['analysis']));
  assert.deepEqual(events, [['indexed', 1, 2], ['indexed', 2, 2], ['analysis'], ['completed', 'a.ts'], ['completed', 'b.ts']]);
});
