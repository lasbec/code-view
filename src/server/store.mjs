import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, isAbsolute, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from '../treemap/src/scoring.mjs';
import { normalizeAuthorIdentities } from '../treemap/src/authors.mjs';

export const defaultPreset = () => ({ name: 'Complexity', config: { area: 'code_files.effective_lines', operation: 'sum', scores: [{ name: 'Complexity', normalize: true, metrics: [{ metric: 'code_functions.cyclomatic_complexity', min: 10, aggregation: 'sum', factor: 1 }] }] }, options: { include: [], exclude: [] } });
export function check(condition, message) { if (!condition) throw Object.assign(new Error(message), { status: 400 }); }
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function patterns(value = []) { check(Array.isArray(value) && value.every(p => typeof p === 'string' && p.length > 0), 'Patterns must be nonempty strings.'); return value; }
export function validateInspection(value) {
  check(object(value), 'Inspection must be an object.');
  check(typeof value.name === 'string' && value.name.trim(), 'A name is required.');
  check(typeof value.repository === 'string' && isAbsolute(value.repository), 'Repository must be an absolute directory path.');
  check(typeof value.tsconfig === 'string' && value.tsconfig && !isAbsolute(value.tsconfig), 'tsconfig must be relative to the repository.');
  const repository = resolve(value.repository), tsconfig = relative(repository, resolve(repository, value.tsconfig));
  check(tsconfig && tsconfig !== '..' && !tsconfig.startsWith(`..${sep}`), 'tsconfig must stay inside the repository.');
  check(value.commits == null || Number.isSafeInteger(value.commits) && value.commits > 0, 'Commit limit must be a positive integer or empty for all history.');
  let authorIdentities;
  try { authorIdentities = normalizeAuthorIdentities(value.authorIdentities); }
  catch (error) { check(false, error.message); }
  return { name: value.name.trim(), repository, tsconfig, commits: value.commits ?? null, include: patterns(value.include), exclude: patterns(value.exclude), authorIdentities };
}
export function validatePreset(value) {
  check(object(value) && typeof value.name === 'string' && value.name.trim(), 'A preset name is required.');
  const c = value.config;
  try { validateConfig(c); } catch (error) { check(false, error.message); }
  const o = value.options ?? {};
  check(object(o) && Object.keys(o).every(k => ['include', 'exclude', 'since', 'until'].includes(k)), 'Invalid treemap filters.');
  for (const k of ['since', 'until']) check(o[k] === undefined || typeof o[k] === 'string' && Number.isFinite(Date.parse(o[k])), 'Dates must be valid ISO timestamps.');
  check(!o.since || !o.until || Date.parse(o.since) <= Date.parse(o.until), 'Since must precede until.');
  return { name: value.name.trim(), config: c, options: { ...o, include: patterns(o.include), exclude: patterns(o.exclude) } };
}
export async function openStore(directory) {
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, 'config.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { inspections: [], presets: [{ id: randomUUID(), ...defaultPreset() }], selection: {} }; }
  // Old presets are deliberately discarded, not translated to new semantics.
  // Keep repository configuration, result metadata and inspection selection intact.
  if (state.presetSchema !== 2) {
    state.presets = [{ id: randomUUID(), ...defaultPreset() }];
    state.selection.preset = state.presets[0].id;
    state.presetSchema = 2;
    await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  let queue = Promise.resolve();
  return {
    get: () => structuredClone(state),
    update(change) {
      const operation = queue.then(async () => {
        const next = structuredClone(state);
        const result = await change(next);
        await writeFile(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
        state = next;
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
