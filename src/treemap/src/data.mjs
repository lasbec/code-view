import initSqlJs from 'sql.js/dist/sql-asm-memory-growth.js';
import { minimatch } from 'minimatch';
import { validateDisplay } from './display.mjs';
import { aggregate } from './scoring.mjs';
import { attachFunctions } from './function-view.mjs';
import { normalizeAuthorEmail, normalizeAuthorIdentities } from './authors.mjs';

let engine;
import { rows, sources, normalizePath } from '../../score-code/measurements.mjs';
import { calculateScores } from '../../score-code/calculate.mjs';
export { normalizePath } from '../../score-code/measurements.mjs';
const join = (base, value) => normalizePath(base ? `${base}/${value}` : value);
const fail = message => { throw new Error(message); };
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
    if (options.showFunctions !== undefined && typeof options.showFunctions !== 'boolean') fail('showFunctions must be a boolean.');
    if (options.includeZeroArea !== undefined && typeof options.includeZeroArea !== 'boolean') fail('includeZeroArea must be a boolean.');
    const identities = new Map(normalizeAuthorIdentities(options.authorIdentities).flatMap(identity =>
      [identity.email, ...identity.aliases].map(email => [email, identity])));
    for (const name of ['include', 'exclude']) if (options[name] !== undefined && (!Array.isArray(options[name]) || options[name].some(p => typeof p !== 'string'))) fail(`${name} muss eine Liste von Glob-Mustern sein.`);
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) fail('SQLite-Inhalt muss als Uint8Array oder ArrayBuffer übergeben werden.');
    if (!bytes.byteLength) fail('Die SQLite-Datei ist leer.');
    const SQL = await (engine ??= initSqlJs());
    db = new SQL.Database(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
    const { catalog, prefix, base, changes, params } = sources(db, options);
    const selected = validateDisplay(config);
    const scoreData = options.scoreData ?? calculateScores(db, { fields: config.fields }, options);
    const fileScores = new Map(scoreData.files.map(f => [f.id, f])), functionScores = new Map(scoreData.functions.map(f => [f.id, f]));
    const needed = new Set([selected.area]);
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
    for (const metric of needed) {
      const source = catalog.get(metric);
      const records = rows(db, `SELECT ${source.file} AS file, ${source.expression} AS value FROM ${source.from}`, source.params);
      const byFile = new Map();
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
      if (missing.size) diagnostics.push({ severity: 'warning', code: 'missing-values', message: `${metric}: fehlende Messwerte in ${missing.size} Datei(en); unvollständige Abhängigkeitsmetriken werden vom Score ausgeschlossen.`, paths: [...missing] });
    }
    const omitted = [];
    let observedMax = 0;
    const visible = [];
    for (const file of files) {
      file.area = file.metrics[selected.area];

      if (file.area <= 0 && !options.includeZeroArea) omitted.push(file.path);
      else visible.push(file);
    }
    if (omitted.length) diagnostics.push({ severity: 'warning', code: 'nonpositive-area', message: `${omitted.length} Datei(en) mit Fläche ≤ 0 werden nicht dargestellt.`, paths: omitted });
    if (!visible.length) diagnostics.push({ severity: 'warning', code: 'empty', message: 'Keine darstellbaren Dateien. Pfadfilter und Flächenkennzahl prüfen.' });
    const functionNodes = options.showFunctions ? attachFunctions(db, visible, selected, catalog, rows) : [];
    const scoredNodes = [...visible, ...functionNodes];
    const values = [];
    for (const node of scoredNodes) {
      const result = (node.kind === 'function' ? functionScores : fileScores).get(node.id);
      node.heat = result?.score ?? null;
      node.error = result?.error ?? null;
      node.scores = (result?.contributions ?? []).map(c => ({ ...c, raw: c.value, contributions: [] }));
      if (node.heat !== null) values.push(node.heat);
      if (node.error) diagnostics.push({ severity: 'warning', code: 'score-error', message: `${node.path}: ${node.error}` });
    }
    observedMax = values.length ? values.reduce((max, value) => Math.max(max, value), -Infinity) : 0;
    const min = selected.heat.min ?? (values.length ? values.reduce((min, value) => Math.min(min, value), 0) : 0);
    const max = selected.heat.max ?? observedMax;
    const yellowFrom = selected.heat.yellowFrom ?? min + (max - min) / 3;
    const redFrom = selected.heat.redFrom ?? min + 2 * (max - min) / 3;
    if (max === min && Object.keys(selected.heat).length || max < min || max > min && !(min < yellowFrom && yellowFrom < redFrom && redFrom < max)) fail('Heat stops must increase: min < yellow < red < max.');
    const legend = { min, max, yellowFrom, redFrom };
    for (const file of scoredNodes) file.color = file.heat === null ? '#c9d0d8' : colorFor(file.heat, legend);
    return { ok: true, files: visible, tree: makeTree(visible), legend, heat: selected.heat, observedMax, observedMin: values.reduce((min,value) => Math.min(min,value),0), areaMetric: selected.area, diagnostics };
  } catch (error) {
    diagnostics.push({ severity: 'error', code: 'calculation-failed', message: `Treemap konnte nicht erstellt werden: ${error.message}` });
    return { ok: false, files: [], tree: null, legend: null, diagnostics };
  } finally { db?.close(); }
}
