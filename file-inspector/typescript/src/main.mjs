#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadProject } from './project.mjs';
import { analyze } from './analyze.mjs';
import { openDatabase, writeFileResult, writeMetadata, removeFile } from './database.mjs';
import { fingerprints } from './incremental.mjs';
import { solveTermination } from './termination.mjs';
import { existsSync } from 'node:fs';
export function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    tsconfig: { type: 'string', short: 'p' }, output: { type: 'string', short: 'o' },
    include: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node src/main.mjs --tsconfig /repo/tsconfig.json --output /path/analysis.sqlite [--include "src/**/*.ts"] [--exclude "**/*.test.ts"]\nRepeat --include/--exclude for multiple globs. Patterns are relative to the main tsconfig directory. Output is replaced after successful analysis.');
    return;
  }
  if (!values.tsconfig || !values.output) throw new Error('--tsconfig and --output are required (see --help).');
  const project = loadProject(values.tsconfig, values.include ?? [], values.exclude ?? []);
  const hashes = fingerprints(project);
  const db = openDatabase(values.output, project);
  let result;
  try {
    const previous = new Map(db.prepare('SELECT file_id, fingerprint FROM file_state').all().map(r => [r.file_id,r.fingerprint]));
    const changed = new Set([...hashes].filter(([file, fingerprint]) => previous.get(file) !== fingerprint).map(([file]) => file));
    const cached = { functions: db.prepare('SELECT * FROM functions').all(), calls: db.prepare('SELECT * FROM calls').all() };
    result = analyze(project, changed, cached, (partial, file) => {
      writeFileResult(db, partial, file, hashes.get(file.id));
    });
    db.exec('BEGIN');
    try {
      const update = db.prepare('UPDATE functions SET termination=?, termination_reason=?, shadowing_count=? WHERE id=?');
      const states = solveTermination(db.prepare('SELECT * FROM functions').all(), db.prepare('SELECT * FROM calls').all());
      for (const [id, state] of states) {
        const f = result.functions.find(f => f.id === id);
        if (f) Object.assign(f, state);
        update.run(state.termination, state.termination_reason, f?.shadowing_count ?? cached.functions.find(f => f.id === id)?.shadowing_count ?? 0, id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    // CLI filters select work, they do not remove other files' stored results.
    for (const file of previous.keys()) if (!existsSync(path.resolve(project.base, file))) {
      db.exec('BEGIN');
      try { removeFile(db, file); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    writeMetadata(db, project);
    result.skipped_files = project.files.length - changed.size;
    console.log(`${result.files.length} files updated, ${result.skipped_files} reused, ${result.functions.length} functions analyzed → ${path.resolve(values.output)}`);
    if (result.diagnostics.length) console.error(`${result.diagnostics.length} TypeScript diagnostic(s) recorded; unresolved types may reduce precision.`);
  } finally { db.close(); }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`Inspector: ${error.message}`); process.exitCode = 1; }
}
