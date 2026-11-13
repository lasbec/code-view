#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadProject } from './project.mjs';
import { analyze } from './analyze.mjs';
import { openDatabase, writeFileResult, writeMetadata, commitDatabase } from './database.mjs';
import { progressReporter } from './progress.mjs';
import { fingerprints } from './incremental.mjs';
export function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    progress: { type: 'boolean' }, tsconfig: { type: 'string', short: 'p' }, output: { type: 'string', short: 'o' },
    include: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node src/main.mjs --tsconfig /repo/tsconfig.json --output /path/analysis.sqlite [--progress] [--include "src/**/*.ts"] [--exclude "**/*.test.ts"]\nRepeat --include/--exclude for multiple globs. Patterns are relative to the main tsconfig directory. Each run rebuilds the known code_ tables, views and indexes in one transaction. Other database objects are preserved. Filters select the entire new result set; errors preserve previous results.');
    return;
  }
  if (!values.tsconfig || !values.output) throw new Error('--tsconfig and --output are required (see --help).');
  const progress = progressReporter(values.progress);
  progress('preparing');
  const project = loadProject(values.tsconfig, values.include ?? [], values.exclude ?? []);
  for (const d of project.diagnostics.filter(d => d.code === 18003)) {
    console.error(`Warning: ${d.file}: ${d.message}`);
  }
  const total = project.files.length;
  let completed = 0;
  progress('preparing', 0, total, 'Preparing dependency fingerprints');
  const hashes = fingerprints(project, (count, total) => progress('preparing', 0, total, `Preparing fingerprints: ${count}/${total} files`));
  const db = openDatabase(values.output, project);
  let result;
  try {
    result = analyze(project, undefined, undefined, (partial, file) => {
      writeFileResult(db, partial, file, hashes.get(file.id));
      completed++;
      progress(completed === total ? 'finalizing' : 'processing', completed, total);
    }, (count, total) => progress('preparing', 0, total, `Indexing symbols: ${count}/${total} files`), () => progress(total ? 'processing' : 'finalizing', 0, total));
    // The analyzer finalizes termination after producing the per-file results.
    const update = db.prepare('UPDATE code_functions SET termination=?, termination_reason=?, shadowing_count=? WHERE id=?');
    for (const f of result.functions) update.run(f.termination, f.termination_reason, f.shadowing_count, f.id);
    writeMetadata(db, project);
    commitDatabase(db);
    result.skipped_files = 0;
    console.log(`${result.files.length} files analyzed, ${result.functions.length} functions analyzed → ${path.resolve(values.output)}`);
    if (result.diagnostics.length) console.error(`${result.diagnostics.length} TypeScript diagnostic(s) recorded; unresolved types may reduce precision.`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`Inspector: ${error.message}`); process.exitCode = 1; }
}
