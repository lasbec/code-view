import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { calculateScores } from './calculate.mjs';

export const computationVersion = 2;
export function scoreKey(definition, filter) {
  return createHash('sha256').update(JSON.stringify({ version: computationVersion, definition, filter })).digest('hex');
}
function loadRun(db,key) {
  if (!db.prepare('SELECT 1 FROM score_runs WHERE id=?').get(key)) return null;
  const result = { files: [], functions: [], runId: key, cached: true };
  const parts = new Map();
  for (const row of db.prepare('SELECT * FROM score_contributions WHERE run_id=? ORDER BY position').all(key)) {
    const id = `${row.kind}:${row.entity_id}`; if (!parts.has(id)) parts.set(id, []); parts.get(id).push(JSON.parse(row.detail));
  }
  for (const row of db.prepare('SELECT * FROM score_results WHERE run_id=?').all(key)) result[row.kind === 'file' ? 'files' : 'functions'].push({ id: row.entity_id, file_id: row.file_id, path: row.path, score: row.score, error: row.error, contributions: parts.get(`${row.kind}:${row.entity_id}`) ?? [] });
  return result;
}
export function ensureScores(path, definition, filter, progress, blocked) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS score_runs (id TEXT PRIMARY KEY, definition TEXT NOT NULL, filter TEXT NOT NULL, completed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS score_results (run_id TEXT NOT NULL REFERENCES score_runs(id) ON DELETE CASCADE, kind TEXT NOT NULL, entity_id TEXT NOT NULL, file_id TEXT NOT NULL, path TEXT, score REAL, error TEXT, PRIMARY KEY(run_id,kind,entity_id));
      CREATE TABLE IF NOT EXISTS score_contributions (run_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, position INTEGER NOT NULL, field_id TEXT NOT NULL, name TEXT NOT NULL, value REAL, error TEXT, detail TEXT NOT NULL, PRIMARY KEY(run_id,kind,entity_id,position));`);
    const key = scoreKey(definition, filter);
    const cached = loadRun(db,key);
    if (cached) return cached;
    const result = calculateScores(db, definition, filter, progress, blocked);
    db.exec('BEGIN IMMEDIATE');
    try {
      const concurrent = loadRun(db,key);
      if (concurrent) { db.exec('COMMIT'); return concurrent; }
      db.prepare('INSERT INTO score_runs VALUES(?,?,?,?)').run(key, JSON.stringify(definition), JSON.stringify(filter), new Date().toISOString());
      const save = db.prepare('INSERT INTO score_results VALUES(?,?,?,?,?,?,?)');
      const part = db.prepare('INSERT INTO score_contributions VALUES(?,?,?,?,?,?,?,?,?)');
      for (const [kind, items] of [['file', result.files], ['function', result.functions]]) for (const item of items) {
        save.run(key, kind, item.id, item.file_id ?? item.id, item.path ?? null, item.score, item.error);
        item.contributions.forEach((c, index) => part.run(key, kind, item.id, index, c.fieldId, c.name, c.value, c.error, JSON.stringify(c)));
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { ...result, runId: key, cached: false };
  } finally { db.close(); }
}
