import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, isAbsolute, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const defaultPreset = () => ({ name: 'Complexity', config: { area: 'code_files.size_bytes', scores: [{ name: 'Complexity', metrics: [{ metric: 'code_functions.cyclomatic_complexity', factor: 1 }] }] }, options: { include: [], exclude: [] } });
export function check(condition, message) { if (!condition) throw Object.assign(new Error(message), { status: 400 }); }
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function patterns(value = []) { check(Array.isArray(value) && value.every(p => typeof p === 'string' && p.length > 0), 'Patterns must be nonempty strings.'); return value; }
export function validateInspection(value) {
  check(object(value), 'Inspection must be an object.');
  check(typeof value.name === 'string' && value.name.trim(), 'A name is required.');
  check(typeof value.repository === 'string' && isAbsolute(value.repository), 'Repository must be an absolute directory path.');
  check(typeof value.tsconfig === 'string' && value.tsconfig && !isAbsolute(value.tsconfig), 'tsconfig must be relative to the repository.');
  const repository = resolve(value.repository), tsconfig = relative(repository, resolve(repository, value.tsconfig));
  check(tsconfig && tsconfig !== '..' && !tsconfig.startsWith(`..${sep}`), 'tsconfig must stay inside the repository.');
  check(value.commits == null || Number.isSafeInteger(value.commits) && value.commits > 0, 'Commit limit must be a positive integer or empty for all history.');
  return { name: value.name.trim(), repository, tsconfig, commits: value.commits ?? null, include: patterns(value.include), exclude: patterns(value.exclude) };
}
export function validatePreset(value) {
  check(object(value) && typeof value.name === 'string' && value.name.trim(), 'A preset name is required.');
  const c = value.config;
  check(object(c) && Object.keys(c).every(k => ['area', 'scores', 'heat'].includes(k)), 'Invalid treemap configuration.');
  check(typeof c.area === 'string' && c.area, 'Choose an area metric.');
  check(Array.isArray(c.scores) && c.scores.length >= 1 && c.scores.length <= 3, 'Use one to three score groups.');
  for (const s of c.scores) {
    check(object(s) && typeof s.name === 'string' && s.name.trim() && Array.isArray(s.metrics) && s.metrics.length, 'Each score needs a name and metrics.');
    for (const m of s.metrics) {
      check(object(m) && typeof m.metric === 'string' && m.metric, 'Choose a score metric.');
      check(Object.keys(m).every(k => ['metric', 'min', 'max', 'factor'].includes(k)), 'Unknown metric option.');
      for (const k of ['min', 'max', 'factor']) check(m[k] === undefined || finite(m[k]), `${k} must be nonnegative.`);
      check(m.max === undefined || m.max > (m.min ?? 0), 'Maximum must exceed minimum.');
    }
  }
  if (c.heat !== undefined) {
    check(object(c.heat) && Object.keys(c.heat).every(k => ['min', 'max', 'yellowFrom', 'redFrom'].includes(k)), 'Invalid heat options.');
    for (const v of Object.values(c.heat)) check(finite(v), 'Heat values must be nonnegative.');
    const h = c.heat;
    // Check all explicitly supplied stops, including nonadjacent ones.
    const stops = [h.min ?? 0, h.yellowFrom, h.redFrom, h.max].filter(v => v !== undefined);
    check(stops.every((v, i) => i === 0 || v > stops[i - 1]), 'Heat stops must increase: minimum, yellow, red, maximum.');
  }
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
