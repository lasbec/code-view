import initSqlJs from 'sql.js/dist/sql-asm-memory-growth.js';
import { minimatch } from 'minimatch';
import { metricById } from './catalog.mjs';
import { aggregate, validateConfig, scoreMeasurements } from './scoring.mjs';
import { attachFunctions } from './function-view.mjs';
import { normalizeAuthorEmail, normalizeAuthorIdentities } from './authors.mjs';

let engine;
const quote = name => `"${name.replaceAll('"', '""')}"`;
export const normalizePath = value => {
  const parts = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return (value.startsWith('/') ? '/' : '') + parts.join('/');
};
const join = (base, value) => /^(\/|[A-Za-z]:)/.test(value) ? normalizePath(value) : normalizePath(base ? `${base}/${value}` : value);
const directory = value => value.slice(0, value.lastIndexOf('/'));
function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const result = [];
    while (statement.step()) result.push(statement.getAsObject());
    return result;
  } finally { statement.free(); }
}
function fail(message) { throw new Error(message); }
function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} muss ein Objekt sein.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}: unbekannte Option "${key}".`);
}
function sources(db, options) {
  const tables = new Set(rows(db, "SELECT name FROM sqlite_master WHERE type IN ('table','view')").map(r => r.name));
  if (!tables.has('code_files')) fail('Die SQLite-Datei enthält keine code_files. Zuerst den Code-Inspector ausführen.');
  const metadata = tables.has('code_metadata') ? Object.fromEntries(rows(db, 'SELECT key,value FROM code_metadata').map(r => [r.key, r.value])) : {};
  const repos = tables.has('git_repositories') ? rows(db, 'SELECT id,path FROM git_repositories') : [];
  const configPath = normalizePath(metadata.tsconfig ?? '');
  const base = directory(configPath);
  const repo = options.repository !== undefined
    ? repos.find(r => String(r.id) === String(options.repository) || normalizePath(r.path) === normalizePath(String(options.repository)))
    : repos.filter(r => base === normalizePath(r.path) || base.startsWith(normalizePath(r.path) + '/')).sort((a, b) => b.path.length - a.path.length)[0] ?? (repos.length === 1 ? repos[0] : undefined);
  if (options.repository !== undefined && !repo) fail('Das ausgewählte Git-Repository wurde nicht gefunden.');
  if (repos.length && !repo) fail('Git-Repository nicht eindeutig zuordenbar. repository und gegebenenfalls codePrefix angeben.');
  let prefix = options.codePrefix;
  if (prefix === undefined && repo) {
    const root = normalizePath(repo.path);
    if (base !== root && !base.startsWith(root + '/')) fail('Code- und Git-Pfadbasen passen nicht zusammen. codePrefix relativ zum Git-Repository angeben.');
    prefix = base.slice(root.length).replace(/^\//, '');
  }
  prefix ??= '';
  if (typeof prefix !== 'string' || /^(\/|[A-Za-z]:)/.test(prefix) || normalizePath(prefix).startsWith('..')) fail('codePrefix muss ein relativer Pfad innerhalb des Repositorys sein.');
  const params = [];
  let where = '';
  for (const [name, operator] of [['since', '>='], ['until', '<=']]) {
    if (options[name] !== undefined) {
      if (typeof options[name] !== 'string' || !Number.isFinite(Date.parse(options[name]))) fail(`${name} muss ein gültiger ISO-Zeitpunkt sein.`);
      where += ` AND julianday(c.committed_at) ${operator} julianday(?)`;
      params.push(new Date(options[name]).toISOString());
    }
  }
  if (options.since && options.until && Date.parse(options.since) > Date.parse(options.until)) fail('since muss vor until liegen.');
  if (repo) params.unshift(repo.id);
  const changes = repo && tables.has('git_file_changes') && tables.has('git_commits')
    ? `(SELECT ch.* FROM git_file_changes ch JOIN git_commits c ON c.repository_id=ch.repository_id AND c.hash=ch.commit_hash WHERE ch.repository_id=?${where})`
    : null;
  const definitions = [
    ['code_files', 't.id', ''],
    ['code_functions', 't.file_id', ''],
    ...['code_parameters', 'code_accesses'].map(t => [t, 'fn.file_id', ' JOIN code_functions fn ON fn.id=t.function_id']),
    ['code_calls', 't.file_id', ''], ['code_function_references', 't.file_id', ''],
    ['code_diagnostics', 't.file', ''],
  ].filter(([table]) => tables.has(table)).map(([table, file, joins]) => ({ table, file, from: `${quote(table)} t${joins}`, params: [], git: false }));
  if (changes) {
    definitions.push({ table: 'git_file_changes', file: 't.path', from: `${changes} t`, params, git: true });
    const commitFiles = `(SELECT DISTINCT repository_id,commit_hash,path FROM ${changes})`;
    for (const table of ['git_commits', 'git_merge_conflict_files', 'git_merge_conflicts']) {
      if (!tables.has(table)) continue;
      if (['git_merge_conflict_files', 'git_merge_conflicts'].includes(table)) {
        if (table === 'git_merge_conflicts' && !tables.has('git_merge_conflict_paths')) continue;
        const mapping = table === 'git_merge_conflicts' ? ' JOIN git_merge_conflict_paths cp ON cp.repository_id=t.repository_id AND cp.commit_hash=t.commit_hash AND cp.conflict_position=t.position' : '';
        definitions.push({ table, file: table === 'git_merge_conflicts' ? 'cp.path' : 't.path', from: `${quote(table)} t${mapping} JOIN git_commits c ON c.repository_id=t.repository_id AND c.hash=t.commit_hash WHERE t.repository_id=?${where}`, params, git: true });
        continue;
      }
      definitions.push({ table, file: 'ch.path', from: `${quote(table)} t JOIN ${commitFiles} ch ON ch.repository_id=t.repository_id AND ch.commit_hash=t.hash`, params, git: true });
    }
  }
  const catalog = new Map();
  for (const source of definitions) {
    const columns = new Set(rows(db, `PRAGMA table_info(${quote(source.table)})`).map(column => column.name));
    for (const entry of metricById.values()) {
      const [table, field] = entry.metric.split('.');
      if (table !== source.table || field !== 'count' && !columns.has(field)) continue;
      catalog.set(entry.metric, { ...entry, ...source, expression: field === 'count' ? '1' : `t.${quote(field)}` });
    }
  }
  return { catalog, prefix, base, changes, params };
}
export function colorFor(value, legend) {
  const { min, max, yellowFrom, redFrom } = legend;
  if (max === min) return 'rgb(34, 160, 70)';
  const stops = [[min, [34, 160, 70]], [yellowFrom, [255, 215, 0]], [redFrom, [225, 45, 45]], [max, [135, 55, 190]]];
  for (let i = 1; i < stops.length; i++) {
    if (value <= stops[i][0]) {
      const ratio = Math.max(0, Math.min(1, (value - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0])));
      return `rgb(${stops[i][1].map((v, j) => Math.round(stops[i - 1][1][j] + ratio * (v - stops[i - 1][1][j]))).join(', ')})`;
    }
  }
  return 'rgb(135, 55, 190)';
}
function makeTree(files) {
  const root = { name: '/', path: '', children: [], area: 0 };
  for (const file of files) {
    const segments = file.path.split('/');
    let node = root;
    node.area += file.area;
    for (let i = 0; i < segments.length - 1; i++) {
      const path = segments.slice(0, i + 1).join('/');
      let child = node.children.find(c => c.children && c.path === path);
      if (!child) { child = { name: segments[i], path, children: [], area: 0 }; node.children.push(child); }
      child.area += file.area;
      node = child;
    }
    node.children.push({ ...file, name: segments.at(-1) });
  }
  if (!Number.isFinite(root.area)) fail('Die Summe der Flächen ist zu groß. Eine kleinere Flächenkennzahl wählen.');
  return root;
}
export async function listMetrics(bytes, options = {}) {
  const SQL = await (engine ??= initSqlJs());
  const db = new SQL.Database(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
  try { return [...sources(db, options).catalog].map(([metric, { label, description, aggregation, aggregations, counter }]) => ({ metric, label, description, aggregation, aggregations, counter })); }
  finally { db.close(); }
}
export async function calculateTreeMap(bytes, config, options = {}) {
  const diagnostics = [];
  let db;
  try {
    keys(options, ['include', 'exclude', 'repository', 'codePrefix', 'since', 'until', 'authorIdentities', 'showFunctions'], 'Optionen');
    if (options.showFunctions !== undefined && typeof options.showFunctions !== 'boolean') fail('showFunctions must be a boolean.');
    const identities = new Map(normalizeAuthorIdentities(options.authorIdentities).flatMap(identity =>
      [identity.email, ...identity.aliases].map(email => [email, identity])));
    for (const name of ['include', 'exclude']) if (options[name] !== undefined && (!Array.isArray(options[name]) || options[name].some(p => typeof p !== 'string'))) fail(`${name} muss eine Liste von Glob-Mustern sein.`);
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) fail('SQLite-Inhalt muss als Uint8Array oder ArrayBuffer übergeben werden.');
    if (!bytes.byteLength) fail('Die SQLite-Datei ist leer.');
    const SQL = await (engine ??= initSqlJs());
    db = new SQL.Database(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
    const { catalog, prefix, base, changes, params } = sources(db, options);
    const selected = validateConfig(config, catalog);
    const needed = new Set([selected.area, ...selected.scores.flatMap(s => s.metrics.map(t => t.metric))]);
    const files = rows(db, 'SELECT id FROM code_files').map(row => ({ id: row.id, path: join(prefix, row.id), metrics: {} })).filter(file =>
      (!(options.include?.length) || options.include.some(p => minimatch(file.path, p.replace(/^\/+/, ''), { dot: true }))) && !(options.exclude ?? []).some(p => minimatch(file.path, p.replace(/^\/+/, ''), { dot: true })));
    const byPath = new Map(files.map(f => [f.path, f]));
    // Count each commit once, even if a change table contains repeated paths.
    const authorColumns = changes ? new Set(rows(db, 'PRAGMA table_info(git_commits)').map(c => c.name)) : new Set();
    const hasAuthors = ['author_name', 'author_email', 'is_merge'].every(name => authorColumns.has(name));
    for (const file of files) {
      file.topAuthors = hasAuthors ? [] : null;
      file.topMergeAuthors = hasAuthors ? [] : null;
    }
    if (hasAuthors) {
      const authors = rows(db, `SELECT ch.path, c.author_email AS email,
        MIN(c.author_name) AS name,
        COUNT(DISTINCT CASE WHEN c.is_merge=0 THEN c.hash END) AS commits,
        COUNT(DISTINCT CASE WHEN c.is_merge=1 THEN c.hash END) AS merges
        FROM ${changes} ch JOIN git_commits c ON c.repository_id=ch.repository_id AND c.hash=ch.commit_hash
        GROUP BY ch.path, c.author_email`, params);
      const byFile = new Map();
      for (const author of authors) {
        const file = byPath.get(normalizePath(author.path));
        if (!file) continue;
        const email = normalizeAuthorEmail(author.email ?? '');
        const identity = identities.get(email) ?? { name: author.name, email };
        if (!byFile.has(file)) byFile.set(file, new Map());
        const combined = byFile.get(file), key = identity.email || identity.name;
        if (!combined.has(key)) combined.set(key, { name: identity.name, email: identity.email, commits: 0, merges: 0 });
        const entry = combined.get(key);
        if (identity.name < entry.name) entry.name = identity.name;
        entry.commits += author.commits;
        entry.merges += author.merges;
      }
      for (const [file, combined] of byFile) {
        for (const [field, count] of [['topAuthors', 'commits'], ['topMergeAuthors', 'merges']]) {
          file[field] = [...combined.values()].filter(a => a[count] > 0)
            .sort((a, b) => b[count] - a[count] || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0))
            .slice(0, 2).map(a => ({ name: a.name, email: a.email, [count]: a[count] }));
        }
      }
    }
    const measurements = new Map();
    for (const metric of needed) {
      const source = catalog.get(metric);
      const records = rows(db, `SELECT ${source.file} AS file, ${source.expression} AS value FROM ${source.from}`, source.params);
      const byFile = new Map();
      measurements.set(metric, byFile);
      const missing = new Set();
      for (const file of files) file.metrics[metric] = 0;
      for (const row of records) {
        let filePath;
        if (source.git) filePath = normalizePath(row.file);
        else if (source.table === 'code_diagnostics' && /^(\/|[A-Za-z]:)/.test(row.file ?? '')) {
          const absolute = normalizePath(row.file);
          if (!base || !absolute.startsWith(base + '/')) continue;
          filePath = join(prefix, absolute.slice(base.length + 1));
        } else filePath = join(prefix, row.file ?? '');
        const file = byPath.get(filePath);
        if (!file) continue;
        if (row.value === null) { missing.add(file.path); continue; }
        if (typeof row.value !== 'number' || !Number.isFinite(row.value)) fail(`Die Kennzahl ${metric} enthält einen ungültigen Zahlenwert für ${file.path}.`);
        if (!byFile.has(file.id)) byFile.set(file.id, []);
        byFile.get(file.id).push(row.value);
      }
      for (const file of files) file.metrics[metric] = aggregate(byFile.get(file.id) ?? [], source.aggregation);
      if (missing.size) diagnostics.push({ severity: 'warning', code: 'missing-values', message: `${metric}: fehlende Messwerte in ${missing.size} Datei(en) als 0 gewertet.`, paths: [...missing] });
    }
    const omitted = [];
    let observedMax = 0;
    const visible = [];
    for (const file of files) {
      file.area = file.metrics[selected.area];
      file.scores = selected.scores.map((score, groupIndex) => ({ ...scoreMeasurements(score, metric => measurements.get(metric).get(file.id) ?? []), groupIndex }));
      if (file.area <= 0) omitted.push(file.path);
      else visible.push(file);
    }
    if (omitted.length) diagnostics.push({ severity: 'warning', code: 'nonpositive-area', message: `${omitted.length} Datei(en) mit Fläche ≤ 0 werden nicht dargestellt.`, paths: omitted });
    if (!visible.length) diagnostics.push({ severity: 'warning', code: 'empty', message: 'Keine darstellbaren Dateien. Pfadfilter und Flächenkennzahl prüfen.' });
    const functionNodes = options.showFunctions ? attachFunctions(db, visible, selected, catalog, rows) : [];
    const scoredNodes = [...visible, ...functionNodes];
    const maxima = selected.scores.map((score, index) => score.max ?? aggregate(scoredNodes.flatMap(node => node.scores.filter(s => s.groupIndex === index).map(s => s.raw)), 'max'));
    for (const file of scoredNodes) {
      file.scores.forEach(score => {
        const index = score.groupIndex;
        score.max = maxima[index];
        score.normalize = selected.scores[index].normalize;
        score.capped = Math.min(score.raw, score.max);
        score.value = score.normalize ? (score.max > 0 ? score.capped / score.max * 100 : 0) : score.capped;
      });
      file.heat = file.scores.length ? aggregate(file.scores.map(score => score.value), selected.operation, selected.quantile) : null;
      if (file.heat !== null && !Number.isFinite(file.heat)) fail(`Score für ${file.path} ist zu groß. Faktoren oder Maxima verkleinern.`);
      observedMax = Math.max(observedMax, file.heat);
    }
    const min = selected.heat.min ?? 0;
    const max = selected.heat.max ?? observedMax;
    const yellowFrom = selected.heat.yellowFrom ?? min + (max - min) / 3;
    const redFrom = selected.heat.redFrom ?? min + 2 * (max - min) / 3;
    if (max < min || (max === min && !(max === 0 && selected.heat.yellowFrom === undefined && selected.heat.redFrom === undefined)) || (max > min && !(min < yellowFrom && yellowFrom < redFrom && redFrom < max))) fail('Farbstützpunkte müssen min < yellowFrom < redFrom < max erfüllen. Nur eine vollständig leere 0-Skala darf zusammenfallen.');
    const legend = { min, max, yellowFrom, redFrom };
    for (const file of scoredNodes) file.color = file.heat === null ? '#c9d0d8' : colorFor(file.heat, legend);
    return { ok: true, files: visible, tree: makeTree(visible), legend, areaMetric: selected.area, diagnostics };
  } catch (error) {
    diagnostics.push({ severity: 'error', code: 'calculation-failed', message: `Treemap konnte nicht erstellt werden: ${error.message}` });
    return { ok: false, files: [], tree: null, legend: null, diagnostics };
  } finally { db?.close(); }
}
