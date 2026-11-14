import { DatabaseSync } from 'node:sqlite';

// Lists share one all-items scoring population. Search and sort never recalculate scores.
export function inspectionList(path, model) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const nodes = new Map();
    for (const file of model.files) {
      nodes.set(file.id, file);
      for (const fn of file.children ?? []) if (fn.kind === 'function') nodes.set(fn.id, fn);
    }
    const mutations = new Map(db.prepare(`SELECT function_id,
      SUM(CASE WHEN effect='definite' THEN mutations ELSE 0 END) AS definite,
      SUM(CASE WHEN effect='possible' THEN mutations ELSE 0 END) AS possible
      FROM code_accesses GROUP BY function_id`).all().map(row => [row.function_id, row]));
    const traitsAvailable = db.prepare('PRAGMA table_info(code_functions)').all().some(c => c.name === 'visibility');
    const functions = db.prepare('SELECT * FROM code_functions').all().map(fn => ({
      id: fn.id, name: fn.name, file_id: fn.file_id, path: fn.file_id, line: fn.line,
      signature: fn.signature ?? '', kind: fn.kind, visibility: fn.visibility ?? null,
      is_static: fn.is_static ?? null, is_async: fn.is_async ?? null,
      is_generator: fn.is_generator ?? null, is_exported: fn.is_exported ?? null,
      score: nodes.get(fn.id)?.heat ?? null, total_lines: fn.total_lines,
      call_depth: fn.call_depth ?? null, reachable_internal_count: fn.reachable_internal_count ?? null,
      down_call_depth: fn.down_call_depth ?? null,
      reachable_external_count: fn.reachable_external_count ?? null, reachable_symbol_count: fn.reachable_symbol_count ?? null,
      direct_external_count: fn.direct_external_count ?? null, dependency_complete: fn.dependency_complete ?? null, call_graph_complete: fn.call_graph_complete ?? fn.dependency_complete ?? null, direct_external_complete: fn.direct_external_complete ?? fn.dependency_complete ?? null,
      complexity: fn.cyclomatic_complexity,
      definite: mutations.get(fn.id)?.definite ?? 0, possible: mutations.get(fn.id)?.possible ?? 0,
    }));
    const byFile = new Map();
    for (const fn of functions) {
      if (!byFile.has(fn.file_id)) byFile.set(fn.file_id, { function_count: 0, complexity: 0, definite: 0, possible: 0 });
      const summary = byFile.get(fn.file_id);
      summary.function_count++; summary.complexity += fn.complexity;
      summary.definite += fn.definite; summary.possible += fn.possible;
    }
    const files = db.prepare('SELECT id,total_lines,effective_lines FROM code_files').all().map(file => ({
      ...file, name: file.id.split('/').at(-1), path: nodes.get(file.id)?.path ?? file.id, score: nodes.get(file.id)?.heat ?? null,
      function_count: 0, complexity: 0, definite: 0, possible: 0, ...byFile.get(file.id),
    }));
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const externals = tables.has('code_external_references') ? db.prepare('SELECT * FROM code_external_references ORDER BY name,file_id,line').all() : [];
    const externalSymbols = [...Map.groupBy(externals, r => r.symbol_id)].map(([id, references]) => ({ id, name: references[0].name, origin: references[0].origin, kind: references[0].symbol_kind, references }));
    return { files, functions, externalSymbols, traitsAvailable, warnings: model.diagnostics.filter(d => d.severity === 'warning').map(d => d.message) };
  } finally { db.close(); }
}
