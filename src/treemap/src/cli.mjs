#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateTreeMap, listMetrics, renderTreeMap } from './index.mjs';

export function warningsPath(output) {
  const extension = path.extname(output);
  return output.slice(0, extension ? -extension.length : undefined) + '.warnings' + (extension || '.html');
}
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    input: { type: 'string', short: 'i' }, output: { type: 'string', short: 'o' },
    config: { type: 'string' }, 'config-json': { type: 'string' },
    include: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
    repository: { type: 'string' }, 'code-prefix': { type: 'string' }, since: { type: 'string' }, until: { type: 'string' },
    'author-identities': { type: 'string' },
    'show-functions': { type: 'boolean' },
    'list-metrics': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node src/cli.mjs --input analysis.sqlite --output report.html --config scores.json\nAlternative: --config-json \'{"scores":[{"metrics":[{"metric":"code_functions.count"}]}]}\'\nOptional: --include GLOB --exclude GLOB (repeatable), --repository PATH_OR_ID, --code-prefix PATH, --since ISO_DATE, --until ISO_DATE, --author-identities identities.json, --show-functions\nList metrics: --input analysis.sqlite --list-metrics\nWrites the treemap and derived report.warnings.html snippets.');
    return { ok: true };
  }
  if (!values.input) throw new Error('--input ist erforderlich.');
  const options = {};
  if (values['show-functions'] !== undefined) options.showFunctions = values['show-functions'];
  for (const name of ['include', 'exclude', 'repository', 'since', 'until']) if (values[name] !== undefined) options[name] = values[name];
  if (values['code-prefix'] !== undefined) options.codePrefix = values['code-prefix'];
  if (values['list-metrics']) {
    console.log(JSON.stringify(await listMetrics(await readFile(values.input), options), null, 2));
    return { ok: true };
  }
  if (!values.output) throw new Error('--output ist erforderlich.');
  const output = path.resolve(values.output), warnings = warningsPath(output);
  // Resolve existing symlinks too, so an output cannot overwrite the database or config.
  const canonical = async file => {
    try { return await realpath(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(file);
      return parent === file ? file : path.join(await canonical(parent), path.basename(file));
    }
  };
  const protectedPaths = await Promise.all([values.input, values.config, values['author-identities']].filter(Boolean).map(file => canonical(path.resolve(file))));
  for (const file of [output, warnings]) if (protectedPaths.includes(await canonical(file))) throw new Error('Ausgabepfade dürfen Eingabedatei und Konfiguration nicht überschreiben.');
  let result;
  try {
    if (Boolean(values.config) === Boolean(values['config-json'])) throw new Error('Genau eine Option --config oder --config-json angeben.');
    const config = JSON.parse(values.config ? await readFile(values.config, 'utf8') : values['config-json']);
    if (values['author-identities']) options.authorIdentities = JSON.parse(await readFile(values['author-identities'], 'utf8'));
    result = await calculateTreeMap(await readFile(values.input), config, options);
  } catch (error) {
    result = { ok: false, diagnostics: [{ severity: 'error', code: 'input-failed', message: `Treemap konnte nicht erstellt werden: ${error.message}` }] };
  }
  const snippets = renderTreeMap(result);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, snippets.treeMapHtml);
  await writeFile(warnings, snippets.treeMapWarningsHtml);
  return { ...snippets, ok: result.ok };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result = await main(); if (!result.ok) process.exitCode = 1; }
  catch (error) { console.error(`Treemap: ${error.message}`); process.exitCode = 1; }
}
