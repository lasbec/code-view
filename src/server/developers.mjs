import { DatabaseSync } from 'node:sqlite';
import { normalizeAuthorEmail } from '../treemap/src/authors.mjs';
import { aggregate } from '../treemap/src/scoring.mjs';

export const defaultDeveloperPreset = () => ({ name: 'Developers', config: { aggregation: 'average', quantile: 90, normalization: 'none', sizeWeighting: 'none', authorshipThreshold: 2, renormalizeAuthorship: false, attribution: 'proportional', basis: 'churn', merges: 'exclude', created: 1, deleted: 1, changed: 1 } });
export function validateDeveloperPreset(value) {
  const fail = () => { throw Object.assign(new Error('Invalid developer preset.'), { status: 400 }); };
  if (!value || typeof value.name !== 'string' || !value.name.trim()) fail();
  const { sizeWeighting, authorshipThreshold, renormalizeAuthorship } = defaultDeveloperPreset().config;
  const c = { sizeWeighting, authorshipThreshold, renormalizeAuthorship, ...value.config };
  if (!value.config || typeof value.config !== 'object' || Array.isArray(value.config)) fail();
  for (const [k, values] of Object.entries({ aggregation: ['sum','average','max','median','quantile'], normalization: ['none','lines','scale'], sizeWeighting: ['none','size_bytes','total_lines','effective_lines'], attribution: ['winner','proportional'], basis: ['commits','churn'], merges: ['exclude','only','include'] })) if (!values.includes(c[k])) fail();
  for (const k of ['created','deleted','changed','quantile']) if (!Number.isFinite(c[k]) || c[k] < 0) fail();
  if (c.quantile > 100 || !Number.isFinite(c.authorshipThreshold) || c.authorshipThreshold < 0 || c.authorshipThreshold > 100 || typeof c.renormalizeAuthorship !== 'boolean') fail();
  return { name: value.name.trim(), config: Object.fromEntries(Object.keys(defaultDeveloperPreset().config).map(k => [k,c[k]])) };
}
export function authorColor(id) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `hsl(${(hash >>> 0) % 360} 58% 65%)`;
}
export function aggregateDeveloper(values, config) {
  const entries = values.map(v => {
    const factor = v.sizeFactor === undefined ? 1 : v.sizeFactor;
    return { ...v, score: Number.isFinite(v.score) && Number.isFinite(factor) ? v.score * factor : null };
  }).filter(v => v.weight > 0 && Number.isFinite(v.score));
  if (!entries.length) return null;
  if (config.aggregation === 'quantile') return aggregate(entries.map(v => v.score*v.weight), 'quantile', config.quantile);
  const sum = entries.reduce((s,v) => s + v.score*v.weight, 0);
  if (config.aggregation === 'sum') return sum;
  if (config.aggregation === 'average') return sum / entries.reduce((s,v) => s+v.weight,0);
  if (config.aggregation === 'max') return entries.reduce((max,v) => Math.max(max,v.score), -Infinity);
  entries.sort((a,b) => a.score-b.score);
  const target = entries.reduce((s,v) => s+v.weight,0) * .5;
  let cumulative = 0;
  for (const e of entries) { cumulative += e.weight; if (cumulative >= target) return e.score; }
  return entries.at(-1).score;
}
export function developerData(path, files, preset, identities = [], options = {}) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const config = { ...defaultDeveloperPreset().config, ...preset.config }, aliases = new Map(), people = new Map(), fileAuthors = new Map();
    for (const identity of identities) for (const email of [identity.email,...identity.aliases ?? []]) aliases.set(normalizeAuthorEmail(email),identity);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='git_commits'").get()) return { developers: [], mainAuthors: {}, authorship: {}, available: false };
    const columns = db.prepare('PRAGMA table_info(git_file_changes)').all();
    const available = columns.some(c => c.name === 'lines_changed');
    const stats = available ? 'f.lines_created AS created, f.lines_removed AS deleted, f.lines_changed AS changed' : 'NULL AS created,NULL AS deleted,NULL AS changed';
    const rows = db.prepare(`SELECT c.*,f.path,${stats} FROM git_file_changes f JOIN git_commits c ON c.repository_id=f.repository_id AND c.hash=f.commit_hash ORDER BY c.committed_at,c.hash`).all();
    const byPath = new Map(files.map(f => [f.path ?? f.id, f]));
    for (const row of rows) {
      if (!byPath.has(row.path) || (options.since && Date.parse(row.committed_at) < Date.parse(options.since)) || (options.until && Date.parse(row.committed_at) > Date.parse(options.until)) || (config.merges === 'exclude' && row.is_merge) || (config.merges === 'only' && !row.is_merge)) continue;
      const email = normalizeAuthorEmail(row.author_email), identity = aliases.get(email), id = identity?.email ?? email;
      if (!people.has(id)) people.set(id, { id, name: identity?.name ?? row.author_name, color: authorColor(id), files: [], commits: new Map() });
      const person = people.get(id), key = `${row.repository_id}:${row.hash}`;
      if (!person.commits.has(key)) person.commits.set(key, { hash: row.hash, date: row.committed_at, created: 0, deleted: 0, changed: 0 });
      const commit = person.commits.get(key);
      for (const k of ['created','deleted','changed']) commit[k] = commit[k] === null || row[k] === null ? null : commit[k]+row[k];
      if (!fileAuthors.has(row.path)) fileAuthors.set(row.path,new Map());
      const authors = fileAuthors.get(row.path);
      if (!authors.has(id)) authors.set(id,{ id, commits: new Set(), amount: 0, missing: false });
      const author = authors.get(id); author.commits.add(key);
      if (row.created === null || row.deleted === null || row.changed === null) author.missing = true;
      else author.amount += row.created*config.created + row.deleted*config.deleted + row.changed*config.changed;
    }
    let max = 0;
    for (const file of files) if (Number.isFinite(file.score)) max = Math.max(max,file.score);
    const mainAuthors = {}, authorship = {};
    for (const [path, authors] of fileAuthors) {
      const values = [...authors.values()], fallback = config.basis === 'churn' && (values.some(a => a.missing) || !values.some(a => a.amount > 0));
      for (const a of values) a.value = config.basis === 'commits' || fallback ? a.commits.size : a.amount;
      values.sort((a,b) => b.value-a.value || a.id.localeCompare(b.id));
      const winner = values[0], person = people.get(winner.id);
      mainAuthors[path] = { id: winner.id, name: person.name, color: person.color };
      const total = values.reduce((s,a) => s+a.value,0), file = byPath.get(path);
      authorship[path] = { basis: config.basis === 'commits' || fallback ? 'commits' : 'churn', fallback,
        authors: values.map(a => ({ id: a.id, name: people.get(a.id).name, color: people.get(a.id).color, share: a.value / total })) };
      let score = file.score;
      if (config.normalization === 'lines') score = file.effective_lines > 0 && score !== null ? score/file.effective_lines : null;
      if (config.normalization === 'scale' && score !== null) score = max > 0 ? score/max*100 : 0;
      const qualified = options.applyAuthorshipThreshold === false ? values : values.filter(a => a.value / total * 100 > config.authorshipThreshold);
      const denominator = config.renormalizeAuthorship && options.applyAuthorshipThreshold !== false ? qualified.reduce((sum,a) => sum+a.value,0) : total;
      const sizeFactor = config.sizeWeighting === 'none' ? 1 : file[config.sizeWeighting];
      for (const a of qualified) {
        if (config.attribution === 'winner' && a !== winner) continue;
        const weight = config.attribution === 'winner' ? Number(a === winner) : a.value/denominator;
        people.get(a.id).files.push({ path, function_count: file.function_count ?? null, rawScore: file.score, score, weight, sizeFactor: Number.isFinite(sizeFactor) ? sizeFactor : null, contribution: Number.isFinite(score) && Number.isFinite(sizeFactor) && Number.isFinite(score*weight*sizeFactor) ? score*weight*sizeFactor : null, fallback });
      }
    }
    const developers = [...people.values()].map(person => {
      const commits = [...person.commits.values()].reverse(), totals = {}, perCommit = {};
      for (const k of ['created','deleted','changed']) {
        totals[k] = commits.some(c => c[k] === null) ? null : commits.reduce((s,c) => s+c[k],0);
        perCommit[k] = totals[k] === null ? null : totals[k]/commits.length;
      }
      return { ...person, commits, totals, perCommit, score: aggregateDeveloper(person.files,config) };
    });
    developers.sort((a,b) => (b.score ?? -Infinity)-(a.score ?? -Infinity) || a.name.localeCompare(b.name));
    return { developers, mainAuthors, authorship, available };
  } finally { db.close(); }
}
