import { minimatch } from 'minimatch';
import { formulaMetrics } from './catalog.mjs';
import { rows, sources, normalizePath } from './measurements.mjs';
import { createEvaluator, inspectFormula } from './formulas.mjs';
import { validateDefinition } from './config.mjs';

const matches = (path, filter) => (!filter.include?.length || filter.include.some(p => minimatch(path, p.replace(/^\/+/, ''), { dot: true }))) && !filter.exclude?.some(p => minimatch(path, p.replace(/^\/+/, ''), { dot: true }));
const total = values => values.some(v => v === null) ? null : values.reduce((a, b) => a + b, 0);
export function calculateScores(db, definition, filter = {}, progress = () => {}, blocked = {}) {
  const config = validateDefinition(definition), { catalog, prefix, base } = sources(db, filter);
  const files = rows(db, 'SELECT id FROM code_files').map(r => ({ id: r.id, path: normalizePath(`${prefix}/${r.id}`).replace(/^\//, ''), metrics: {}, contributions: [] })).filter(f => matches(f.path, filter));
  const byId = new Map(files.map(f => [f.id, f])), byPath = new Map(files.map(f => [f.path, f]));
  const functions = rows(db, 'SELECT id,file_id FROM code_functions').filter(fn => byId.has(fn.file_id)).map(fn => ({ ...fn, metrics: {}, contributions: [] }));
  const byFunction = new Map(functions.map(fn => [fn.id, fn])), inFile = Map.groupBy(functions, fn => fn.file_id);
  for (const entry of formulaMetrics) {
    const source = catalog.get(entry.metric), targets = entry.scope === 'function' ? functions : files;
    const scalar = entry.type.startsWith('number');
    for (const item of targets) item.metrics[entry.key] = source ? scalar ? null : [] : null;
    if (!source) continue;
    const owner = source.functionOwner ?? (source.table === 'code_functions' ? 't.id' : source.table === 'code_calls' ? 't.caller_id' : 't.function_id');
    for (const row of rows(db, `SELECT ${entry.scope === 'function' ? owner : source.file} AS owner, ${source.expression} AS value FROM ${source.from}`, source.params)) {
      let item;
      if (entry.scope === 'function') item = byFunction.get(row.owner);
      else if (source.git) item = byPath.get(normalizePath(row.owner));
      else if (source.table === 'code_diagnostics' && /^(\/|[A-Za-z]:)/.test(row.owner ?? '')) {
        const path = normalizePath(row.owner); if (!base || !path.startsWith(base + '/')) continue;
        item = byId.get(path.slice(base.length + 1));
      } else item = byId.get(row.owner);
      if (!item) continue;
      if (scalar) item.metrics[entry.key] = row.value;
      else item.metrics[entry.key].push(row.value);
    }
  }
  const compile = createEvaluator();
  for (const field of config.fields) {
    const diagnostics = inspectFormula(field.code, field.kind).diagnostics;
    const invalid = diagnostics.filter(d => d.syntax || [2304,2339,2551,2552].includes(d.code));
    const evaluate = blocked[field.id] ? () => ({ value: null, error: blocked[field.id] }) : invalid.length ? () => ({ value: null, error: invalid.map(d => d.message).join(' ') }) : compile(field.code);
    const contribution = (result, stage = 'formula') => ({ fieldId: field.id, name: field.name, kind: field.kind, code: field.code, ...(stage === 'aggregation' ? { aggregation: field.aggregation } : {}), stage, ...result });
    progress({ fieldId: field.id, stage: 'formula' });
    if (field.kind === 'function') {
      for (const fn of functions) {
        fn.contributions.push(contribution(evaluate(structuredClone(fn.metrics))));
      }
      progress(null);
      const aggregation = blocked[`${field.id}:aggregation`] ? () => ({value:null,error:blocked[`${field.id}:aggregation`]}) : compile(field.aggregation);
      progress({ fieldId: field.id, stage: 'aggregation' });
      for (const file of files) {
        const scores = (inFile.get(file.id) ?? []).map(fn => fn.contributions.at(-1).value);
        file.contributions.push(contribution(scores.includes(null) ? { value: null, error: 'A function contribution failed.' } : aggregation(undefined, scores), 'aggregation'));
      }
    } else {
      for (const file of files) {
        file.contributions.push(contribution(evaluate(structuredClone(file.metrics))));
      }
    }
    progress(null);
  }
  for (const item of [...files, ...functions]) {
    item.score = total(item.contributions.map(c => c.value));
    if (item.score !== null && !Number.isFinite(item.score)) { item.score = null; item.error = 'Total score is not finite.'; }
    else item.error = item.contributions.filter(c => c.error).map(c => `${c.name}: ${c.error}`).join('\n') || null;
    delete item.metrics;
  }
  return { files, functions };
}
