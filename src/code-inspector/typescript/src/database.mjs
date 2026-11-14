import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const schema = `
CREATE TABLE code_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE code_files (
 id TEXT PRIMARY KEY, size_bytes INTEGER, outside_size_bytes INTEGER, total_lines INTEGER, blank_lines INTEGER, comment_lines INTEGER,
 lines_with_comments INTEGER, effective_lines INTEGER, import_statements INTEGER,
 imported_bindings INTEGER, dynamic_imports INTEGER, reexports INTEGER, exported_variables INTEGER
);
CREATE TABLE code_functions (
 id TEXT PRIMARY KEY, file_id TEXT REFERENCES code_files(id), parent_function_id TEXT REFERENCES code_functions(id) DEFERRABLE INITIALLY DEFERRED,
 source_size_bytes INTEGER, exclusive_size_bytes INTEGER, exclusive_effective_lines INTEGER,
 name TEXT, signature TEXT, kind TEXT, visibility TEXT, is_static INTEGER, is_async INTEGER, is_generator INTEGER, is_exported INTEGER, line INTEGER, column INTEGER, end_line INTEGER,
 total_lines INTEGER, blank_lines INTEGER, comment_lines INTEGER, lines_with_comments INTEGER, effective_lines INTEGER,
 max_nesting INTEGER, cyclomatic_complexity INTEGER, cognitive_complexity INTEGER,
 function_argument_usage_internal INTEGER, function_argument_usage_external INTEGER, minimum_function_argument_usage_internal INTEGER, minimum_function_argument_usage_external INTEGER, function_argument_usage_complete INTEGER,
 call_depth INTEGER, down_call_depth INTEGER NOT NULL DEFAULT 0, reachable_internal_count INTEGER, reachable_external_count INTEGER, reachable_symbol_count INTEGER, direct_external_count INTEGER, dependency_complete INTEGER, call_graph_complete INTEGER, direct_external_complete INTEGER, dependency_group_id TEXT,
 termination TEXT CHECK(termination IN ('terminates','unknown')), termination_reason TEXT, termination_candidate INTEGER, shadowing_count INTEGER
);
CREATE TABLE code_external_references (id INTEGER PRIMARY KEY, symbol_id TEXT, name TEXT, origin TEXT, symbol_kind TEXT, file_id TEXT REFERENCES code_files(id), function_id TEXT REFERENCES code_functions(id), alias TEXT, kind TEXT, line INTEGER, column INTEGER);
CREATE INDEX code_external_function ON code_external_references(function_id);
CREATE TABLE code_unknown_references (id INTEGER PRIMARY KEY, file_id TEXT REFERENCES code_files(id), function_id TEXT REFERENCES code_functions(id), expression TEXT, reason TEXT, line INTEGER, column INTEGER);
CREATE TABLE code_dependency_groups (id TEXT PRIMARY KEY, reachable_functions TEXT, external_symbols TEXT, complete INTEGER);
CREATE TABLE code_imports (id INTEGER PRIMARY KEY, file_id TEXT REFERENCES code_files(id), target_file_id TEXT, specifier TEXT, kind TEXT, line INTEGER, column INTEGER);
CREATE TABLE code_symbol_references (id INTEGER PRIMARY KEY, file_id TEXT REFERENCES code_files(id), function_id TEXT REFERENCES code_functions(id), target_file_id TEXT, target_name TEXT, kind TEXT, line INTEGER, column INTEGER);
CREATE TABLE code_exports (file_id TEXT REFERENCES code_files(id), name TEXT);
CREATE TABLE code_parameters (
 id TEXT PRIMARY KEY, function_id TEXT REFERENCES code_functions(id), position INTEGER, name TEXT, type TEXT,
 optional INTEGER, rest INTEGER, mutation_count INTEGER, possible_mutation_count INTEGER
);
CREATE TABLE code_accesses (
 id INTEGER PRIMARY KEY, function_id TEXT REFERENCES code_functions(id), scope TEXT CHECK(scope IN ('outer_function','module','global','class_field','parameter')),
 symbol_name TEXT, symbol_declaration TEXT, expression TEXT, parameter_id TEXT REFERENCES code_parameters(id),
 reads INTEGER, writes INTEGER, mutations INTEGER, effect TEXT CHECK(effect IN ('definite','possible')), line INTEGER, column INTEGER
);
CREATE TABLE code_calls (
 id INTEGER PRIMARY KEY, caller_id TEXT REFERENCES code_functions(id), file_id TEXT REFERENCES code_files(id), target_id TEXT,
 target_name TEXT, resolution TEXT, is_inferred INTEGER NOT NULL DEFAULT 0, kind TEXT, line INTEGER, column INTEGER
);
CREATE TABLE code_function_references (
 id INTEGER PRIMARY KEY, function_id TEXT REFERENCES code_functions(id), file_id TEXT REFERENCES code_files(id), target_id TEXT,
 target_name TEXT, kind TEXT, line INTEGER, column INTEGER
);
CREATE TABLE code_shadowing (
 id INTEGER PRIMARY KEY, function_id TEXT REFERENCES code_functions(id), name TEXT, line INTEGER, column INTEGER, hidden_symbol TEXT, hidden_declaration TEXT
);
CREATE TABLE code_diagnostics (id INTEGER PRIMARY KEY, file TEXT, line INTEGER, code INTEGER, message TEXT);
CREATE TABLE code_file_state (file_id TEXT PRIMARY KEY REFERENCES code_files(id), fingerprint TEXT NOT NULL);
CREATE INDEX code_calls_caller ON code_calls(caller_id);
CREATE INDEX code_calls_target ON code_calls(target_id);
CREATE INDEX code_accesses_function ON code_accesses(function_id);
CREATE INDEX code_references_target ON code_function_references(target_id);
CREATE VIEW code_call_counts AS SELECT caller_id, target_id, target_name, resolution, COUNT(*) AS call_count FROM code_calls GROUP BY caller_id, target_id, target_name, resolution;
CREATE VIEW code_access_counts AS SELECT function_id, scope, effect, SUM(reads) AS reads, SUM(writes) AS writes, SUM(mutations) AS mutations FROM code_accesses GROUP BY function_id, scope, effect;
CREATE VIEW code_file_function_counts AS SELECT code_files.id AS file_id, COUNT(code_functions.id) AS function_count FROM code_files LEFT JOIN code_functions ON code_files.id=code_functions.file_id GROUP BY code_files.id;
`;
export function openDatabase(output, project) {
  output = path.resolve(output);
  const protectedFiles = new Set([...project.files.map(f => path.resolve(f.sf.fileName)), ...project.configs]);
  if (protectedFiles.has(output)) throw new Error('Output must not overwrite a source or configuration file.');
  mkdirSync(path.dirname(output), { recursive: true });
  const db = new DatabaseSync(output);
  try {
    // DROP TABLE must not cascade into tables owned by other applications.
    // Validate all references before committing the replacement instead.
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('BEGIN IMMEDIATE');
    for (const view of ['code_call_counts', 'code_access_counts', 'code_file_function_counts']) db.exec(`DROP VIEW IF EXISTS ${view}`);
    for (const index of ['code_calls_caller', 'code_calls_target', 'code_accesses_function', 'code_references_target']) db.exec(`DROP INDEX IF EXISTS ${index}`);
    for (const table of ['code_external_references', 'code_unknown_references', 'code_dependency_groups', 'code_symbol_references', 'code_imports', 'code_exports', 'code_accesses', 'code_shadowing', 'code_parameters', 'code_calls', 'code_function_references', 'code_file_state', 'code_functions', 'code_files', 'code_diagnostics', 'code_metadata']) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec(schema);
    db.prepare('INSERT INTO code_metadata VALUES (?,?)').run('schema_version', '12');
    db.prepare('INSERT INTO code_metadata VALUES (?,?)').run('tsconfig', project.configPath);
    return db;
  } catch (error) { db.close(); throw error; }
}
export function commitDatabase(db) {
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Rebuilt inspector tables would violate foreign key constraints.');
  db.exec('COMMIT');
}

function insert(db, table, rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const statement = db.prepare(`INSERT INTO ${table} (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`);
  for (const row of rows) statement.run(...keys.map(k => row[k] ?? null));
}
export function writeFileResult(db, result, file, fingerprint) {
  const ids = new Set(result.functions.filter(f => f.file_id === file.id).map(f => f.id));
  insert(db, 'code_files', [file]);
  insert(db, 'code_imports', result.imports.filter(row => row.file_id === file.id));
  insert(db, 'code_exports', result.exports.filter(row => row.file_id === file.id));
  insert(db, 'code_functions', result.functions.filter(f => ids.has(f.id)).map(({ unsafe, ...f }) => ({ ...f, shadowing_count: result.shadows.filter(s => s.function_id === f.id).length })));
  insert(db, 'code_external_references', result.externalReferences.filter(row => row.file_id === file.id));
  insert(db, 'code_unknown_references', result.unknownReferences.filter(row => row.file_id === file.id));
  insert(db, 'code_symbol_references', result.symbolReferences.filter(row => row.file_id === file.id));
  insert(db, 'code_parameters', result.parameters.filter(p => ids.has(p.function_id)));
  insert(db, 'code_accesses', result.accesses.filter(a => ids.has(a.function_id)));
  insert(db, 'code_shadowing', result.shadows.filter(a => ids.has(a.function_id)));
  insert(db, 'code_calls', result.calls.filter(a => a.file_id === file.id));
  insert(db, 'code_function_references', result.references.filter(a => a.file_id === file.id));
  insert(db, 'code_file_state', [{ file_id: file.id, fingerprint }]);
}
export function writeMetadata(db, project) {
  insert(db, 'code_diagnostics', project.diagnostics);
  const statement = db.prepare('INSERT OR REPLACE INTO code_metadata VALUES (?,?)');
  for (const [key, value] of Object.entries({ analyzer_version: '1.0.0', typescript_version: '5.9.3', updated_at: new Date().toISOString(), repository: project.repository, includes: JSON.stringify(project.includes), excludes: JSON.stringify(project.excludes), configs: JSON.stringify(project.configs), termination_model: 'Conservative structural model; see README.' })) statement.run(key, value);
}
