import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
const schema = `
PRAGMA foreign_keys=ON;
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (
 id TEXT PRIMARY KEY, total_lines INTEGER, blank_lines INTEGER, comment_lines INTEGER,
 lines_with_comments INTEGER, effective_lines INTEGER, import_statements INTEGER,
 imported_bindings INTEGER, dynamic_imports INTEGER, reexports INTEGER, exported_variables INTEGER
);
CREATE TABLE functions (
 id TEXT PRIMARY KEY, file_id TEXT REFERENCES files(id), parent_function_id TEXT REFERENCES functions(id) DEFERRABLE INITIALLY DEFERRED,
 name TEXT, kind TEXT, line INTEGER, column INTEGER, end_line INTEGER,
 total_lines INTEGER, blank_lines INTEGER, comment_lines INTEGER, lines_with_comments INTEGER, effective_lines INTEGER,
 max_nesting INTEGER, cyclomatic_complexity INTEGER, cognitive_complexity INTEGER,
 termination TEXT CHECK(termination IN ('terminates','unknown')), termination_reason TEXT, termination_candidate INTEGER, shadowing_count INTEGER
);
CREATE TABLE parameters (
 id TEXT PRIMARY KEY, function_id TEXT REFERENCES functions(id), position INTEGER, name TEXT, type TEXT,
 optional INTEGER, rest INTEGER, mutation_count INTEGER, possible_mutation_count INTEGER
);
CREATE TABLE accesses (
 id INTEGER PRIMARY KEY, function_id TEXT REFERENCES functions(id), scope TEXT CHECK(scope IN ('outer_function','module','global','class_field','parameter')),
 symbol_name TEXT, symbol_declaration TEXT, expression TEXT, parameter_id TEXT REFERENCES parameters(id),
 reads INTEGER, writes INTEGER, mutations INTEGER, effect TEXT CHECK(effect IN ('definite','possible')), line INTEGER, column INTEGER
);
CREATE TABLE calls (
 id INTEGER PRIMARY KEY, caller_id TEXT REFERENCES functions(id), file_id TEXT REFERENCES files(id), target_id TEXT,
 target_name TEXT, resolution TEXT, kind TEXT, line INTEGER, column INTEGER
);
CREATE TABLE function_references (
 id INTEGER PRIMARY KEY, function_id TEXT REFERENCES functions(id), file_id TEXT REFERENCES files(id), target_id TEXT,
 target_name TEXT, kind TEXT, line INTEGER, column INTEGER
);
CREATE TABLE shadowing (
 id INTEGER PRIMARY KEY, function_id TEXT REFERENCES functions(id), name TEXT, line INTEGER, column INTEGER, hidden_symbol TEXT, hidden_declaration TEXT
);
CREATE TABLE diagnostics (id INTEGER PRIMARY KEY, file TEXT, line INTEGER, code INTEGER, message TEXT);
CREATE TABLE file_state (file_id TEXT PRIMARY KEY REFERENCES files(id), fingerprint TEXT NOT NULL);
CREATE INDEX calls_caller ON calls(caller_id);
CREATE INDEX calls_target ON calls(target_id);
CREATE INDEX accesses_function ON accesses(function_id);
CREATE INDEX references_target ON function_references(target_id);
CREATE VIEW call_counts AS SELECT caller_id, target_id, target_name, resolution, COUNT(*) AS call_count FROM calls GROUP BY caller_id, target_id, target_name, resolution;
CREATE VIEW access_counts AS SELECT function_id, scope, effect, SUM(reads) AS reads, SUM(writes) AS writes, SUM(mutations) AS mutations FROM accesses GROUP BY function_id, scope, effect;
CREATE VIEW file_function_counts AS SELECT files.id AS file_id, COUNT(functions.id) AS function_count FROM files LEFT JOIN functions ON files.id=functions.file_id GROUP BY files.id;
`;
export function openDatabase(output, project) {
  output = path.resolve(output);
  const protectedFiles = new Set([...project.files.map(f => path.resolve(f.sf.fileName)), ...project.configs]);
  if (protectedFiles.has(output)) throw new Error('Output must not overwrite a source or configuration file.');
  mkdirSync(path.dirname(output), { recursive: true });
  const existed = existsSync(output);
  const db = new DatabaseSync(output);
  try {
    if (!existed) {
      db.exec('BEGIN'); db.exec(schema);
      db.prepare('INSERT INTO metadata VALUES (?,?)').run('schema_version', '2');
      db.prepare('INSERT INTO metadata VALUES (?,?)').run('tsconfig', project.configPath);
      db.exec('COMMIT');
    } else {
      if (db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value !== '2') throw new Error('Unsupported inspector database schema. Choose another output.');
      if (db.prepare("SELECT value FROM metadata WHERE key='tsconfig'").get()?.value !== project.configPath) throw new Error('Output belongs to another tsconfig. Choose another output.');
    }
    db.exec('PRAGMA foreign_keys=ON');
    return db;
  } catch (error) { db.close(); throw error; }
}
function insert(db, table, rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const statement = db.prepare(`INSERT INTO ${table} (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`);
  for (const row of rows) statement.run(...keys.map(k => row[k] ?? null));
}
export function removeFile(db, id) {
  for (const table of ['accesses', 'shadowing', 'parameters']) db.prepare(`DELETE FROM ${table} WHERE function_id IN (SELECT id FROM functions WHERE file_id=?)`).run(id);
  db.prepare('DELETE FROM calls WHERE file_id=?').run(id);
  db.prepare('DELETE FROM function_references WHERE file_id=?').run(id);
  db.prepare('DELETE FROM functions WHERE file_id=?').run(id);
  db.prepare('DELETE FROM file_state WHERE file_id=?').run(id);
  db.prepare('DELETE FROM files WHERE id=?').run(id);
}
export function writeFileResult(db, result, file, fingerprint) {
  const ids = new Set(result.functions.filter(f => f.file_id === file.id).map(f => f.id));
  db.exec('BEGIN');
  try {
    removeFile(db, file.id);
    insert(db, 'files', [file]);
    insert(db, 'functions', result.functions.filter(f => ids.has(f.id)).map(({ unsafe, ...f }) => ({ ...f, shadowing_count: result.shadows.filter(s => s.function_id === f.id).length })));
    insert(db, 'parameters', result.parameters.filter(p => ids.has(p.function_id)));
    insert(db, 'accesses', result.accesses.filter(a => ids.has(a.function_id)));
    insert(db, 'shadowing', result.shadows.filter(a => ids.has(a.function_id)));
    insert(db, 'calls', result.calls.filter(a => a.file_id === file.id));
    insert(db, 'function_references', result.references.filter(a => a.file_id === file.id));
    insert(db, 'file_state', [{ file_id: file.id, fingerprint }]);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function writeMetadata(db, project) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM diagnostics'); insert(db, 'diagnostics', project.diagnostics);
    const statement = db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)');
    for (const [key, value] of Object.entries({ analyzer_version: '1.0.0', typescript_version: '5.9.3', updated_at: new Date().toISOString(), includes: JSON.stringify(project.includes), excludes: JSON.stringify(project.excludes), configs: JSON.stringify(project.configs), termination_model: 'Conservative structural model; see README.' })) statement.run(key, value);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
