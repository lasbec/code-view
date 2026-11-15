#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createScoreWorker } from './worker-client.mjs';
import { validateDefinition } from './config.mjs';
const { values } = parseArgs({ options: { input: {type:'string'}, score: {type:'string'}, filter: {type:'string'}, output: {type:'string'}, help: {type:'boolean'} } });
if (values.help) {
  console.log('Usage: node src/score-code/cli.mjs --input analysis.sqlite --score score.json [--filter filter.json] [--output results.json]\nWrites scores, contributions and diagnostics to score_* tables in the input SQLite database.');
} else {
  if (!values.input || !values.score) throw new Error('--input and --score are required.');
  const saved = JSON.parse(await readFile(values.score,'utf8'));
  const definition = validateDefinition(saved.config ?? saved);
  const selected = values.filter ? JSON.parse(await readFile(values.filter,'utf8')) : {};
  const worker = createScoreWorker();
  try {
    const result = await worker.request({path:values.input,definition,filter:selected.options ?? selected});
    if (result.error) throw new Error(result.error);
    const json = JSON.stringify(result,null,2)+'\n';
    if (values.output) await writeFile(values.output,json); else process.stdout.write(json);
  } finally { await worker.close(); }
}
