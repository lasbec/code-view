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
    return { files, functions, traitsAvailable, warnings: model.diagnostics.filter(d => d.severity === 'warning').map(d => d.message) };
  } finally { db.close(); }
}
