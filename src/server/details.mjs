import { DatabaseSync } from 'node:sqlite';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { aggregate } from '../treemap/src/scoring.mjs';
const exec = promisify(execFile);
export async function inspectDetail(path, config, id, kind, model, expanded) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const query = (table, sql, ...args) => tables.has(table) ? db.prepare(sql).all(...args) : [];
    const functions = query('code_functions', 'SELECT * FROM code_functions');
    const files = query('code_files', 'SELECT * FROM code_files');
    const entity = (kind === 'function' ? functions : files).find(row => row.id === id);
    if (!entity) throw Object.assign(new Error('Inspection item not found.'), { status: 404 });
    const fileId = kind === 'function' ? entity.file_id : id;
    const file = files.find(row => row.id === fileId);
    const owned = new Set(functions.filter(fn => fn.file_id === fileId).map(fn => fn.id));
    const match = row => kind === 'function' ? row.function_id === id : owned.has(row.function_id);
    const refs = query('code_function_references', 'SELECT * FROM code_function_references');
    const calls = query('code_calls', 'SELECT * FROM code_calls');
    const imports = query('code_imports', 'SELECT * FROM code_imports');
    const accesses = query('code_accesses', 'SELECT * FROM code_accesses').filter(match);
    const nodes = new Map();
    for (const f of expanded?.files ?? []) for (const item of [f, ...(f.children ?? [])]) {
      if (item.kind === 'outside') continue;
      for (const score of item.scores ?? []) {
        const context = model.files[0]?.scores.find(s => s.groupIndex === score.groupIndex);
        if (context) { score.max = context.max; score.capped = Math.min(score.raw, context.max); score.value = score.normalize ? (score.max ? score.capped / score.max * 100 : 0) : score.capped; }
      }
      item.heat = item.scores?.length ? aggregate(item.scores.map(s => s.value), config.preset.config.operation ?? 'sum', config.preset.config.quantile) : null;
      nodes.set(item.id, item);
    }
    for (const f of model.files) { nodes.set(f.id, f); for (const fn of f.children ?? []) nodes.set(fn.id, fn); }
    const node = nodes.get(id);
    const metadata = Object.fromEntries(query('code_metadata', 'SELECT * FROM code_metadata').map(r => [r.key, r.value]));
    const warnings = [];
    let source = null, sourcePath = null;
    try {
      const repository = await realpath(config.repository);
      sourcePath = await realpath(resolve(dirname(metadata.tsconfig || resolve(repository, config.tsconfig)), fileId));
      const rel = relative(repository, sourcePath);
      if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Source is outside the repository.');
      source = await readFile(sourcePath, 'utf8');
    } catch (error) { sourcePath = null; warnings.push(`Current source unavailable: ${error.message}`); }
    try {
      const git = async args => (await exec('git', ['-C', config.repository, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
      const head = await git(['rev-parse', 'HEAD']);
      const tip = query('git_branches', 'SELECT tip_hash FROM git_branches WHERE name=?', config.result?.branch ?? '')[0]?.tip_hash;
      if (!tip) warnings.push('Inspected commit is unavailable. Source consistency cannot be verified.');
      else if (head !== tip) warnings.push(`Current commit ${head.slice(0, 8)} differs from inspected commit ${tip.slice(0, 8)}. Metrics, references and line locations may be outdated.`);
      if (await git(['status', '--porcelain'])) warnings.push('Uncommitted changes: current source may differ from inspection. Metrics, references and line locations may be outdated.');
    } catch { warnings.push('Repository status unavailable. Source consistency cannot be verified.'); }
    if (!tables.has('code_imports')) warnings.push('Run inspection again to collect exact imports and exports.');
    const historyPath = relative(config.repository, resolve(dirname(metadata.tsconfig || resolve(config.repository, config.tsconfig)), fileId)).split(sep).join('/');
    const history = query('git_file_changes', `SELECT ch.path,c.committed_at,c.author_name,c.author_email,c.hash FROM git_file_changes ch JOIN git_commits c ON c.repository_id=ch.repository_id AND c.hash=ch.commit_hash WHERE ch.path=? AND c.is_merge=0 ORDER BY c.committed_at DESC`, historyPath);
    const externalReferences = query('code_external_references', 'SELECT * FROM code_external_references');
    const groups = query('code_dependency_groups', 'SELECT * FROM code_dependency_groups');
    const relevant = groups.filter(g => kind === 'function' ? g.id === entity.dependency_group_id : functions.some(f => owned.has(f.id) && f.dependency_group_id === g.id));
    const reachableFunctions = [...new Set(relevant.flatMap(g => JSON.parse(g.reachable_functions)))];
    const reachableSymbols = new Set(relevant.flatMap(g => JSON.parse(g.external_symbols)));
    if (entity.dependency_complete === 0) warnings.push('Dependency analysis is incomplete. Counts and known paths are lower bounds and are excluded from scores.');
    if (kind === 'function' && entity.dependency_complete != null && entity.call_depth == null) warnings.push('Exact depth is undetermined: the search budget was exceeded or a downstream depth is unavailable.');
    return { kind, entity, reachableFunctions,
      directExternalReferences: externalReferences.filter(r => kind === 'function' ? r.function_id === id : r.file_id === fileId),
      reachableExternalReferences: externalReferences.filter(r => reachableSymbols.has(r.symbol_id) && (reachableFunctions.includes(r.function_id) || (kind === 'function' ? r.function_id === id : owned.has(r.function_id)))),
      unknownReferences: query('code_unknown_references', 'SELECT * FROM code_unknown_references').filter(r => kind === 'function' ? r.function_id === id || reachableFunctions.includes(r.function_id) : r.file_id === fileId || reachableFunctions.includes(r.function_id)), file, fileIds: files.map(f => f.id), node, preset: config.preset.name, warnings, source, sourcePath,
      functions: functions.filter(fn => fn.file_id === fileId).map(fn => ({ ...fn, heat: nodes.get(fn.id)?.heat ?? null })),
      names: functions.map(({ id, name, file_id, line }) => ({ id, name, file_id, line })),
      parent: functions.find(fn => fn.id === entity.parent_function_id),
      incoming: refs.filter(r => kind === 'function' ? r.target_id === id : owned.has(r.target_id)).concat(kind === 'file' ? query('code_symbol_references', 'SELECT * FROM code_symbol_references WHERE target_file_id=?', fileId) : []),
      outgoing: calls.filter(r => kind === 'function' ? r.caller_id === id : r.file_id === fileId),
      imports: imports.filter(r => r.file_id === fileId), importers: imports.filter(r => r.target_file_id === fileId),
      exports: query('code_exports', 'SELECT * FROM code_exports WHERE file_id=?', fileId),
      parameters: query('code_parameters', 'SELECT * FROM code_parameters').filter(match),
      mutations: accesses.filter(r => r.mutations), accesses: accesses.filter(r => r.scope !== 'parameter'),
      diagnostics: query('code_diagnostics', 'SELECT * FROM code_diagnostics').filter(r => r.file === fileId || r.file === sourcePath),
      history: history.slice(0, 30), changeCount: new Set(history.map(row => row.hash)).size };
  } finally { db.close(); }
}
