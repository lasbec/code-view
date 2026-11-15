import { metricById } from './catalog.mjs';
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
export function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    if (typeof statement.all === 'function') return statement.all(...params);
    statement.bind(params);
    const result = [];
    while (statement.step()) result.push(statement.getAsObject());
    return result;
  } finally { statement.free?.(); }
}
function fail(message) { throw new Error(message); }
export function sources(db, options) {
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
      if (table === source.table && field === 'incoming_count') {
        catalog.set(entry.metric, { ...entry, ...source, file: 'target.file_id',
          from: `${source.from} JOIN code_functions target ON target.id=t.target_id`,
          functionOwner: 't.target_id', expression: '1' });
        continue;
      }
      if (table !== source.table || field !== 'count' && !columns.has(field)) continue;
      const completeness = columns.has(entry.completenessField) ? entry.completenessField : 'dependency_complete';
      catalog.set(entry.metric, { ...entry, ...source, expression: field === 'count' ? '1' : entry.nullable ? `CASE WHEN t.${quote(completeness)}=1 THEN t.${quote(field)} END` : `t.${quote(field)}` });
    }
  }
  return { catalog, prefix, base, changes, params };
}
