import { DatabaseSync } from 'node:sqlite';
import { renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { check } from './store.mjs';

export const inspectors = ['code', 'git'];
export const fingerprint = (config, inspector) => JSON.stringify(Object.fromEntries(
  (inspector === 'code' ? ['repository', 'tsconfig', 'include', 'exclude'] : ['repository', 'commits']).map(k => [k, config[k]])));
export function usable(path, inspector = 'code') {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    return (inspector === 'code' ? ['code_files'] : ['git_repositories', 'git_commits']).every(t => tables.has(t));
  } catch { return false; } finally { db?.close(); }
}
export class Results {
  constructor(directory) { this.directory = directory; }
  path(id, filename) { return resolve(this.directory, id, filename); }
  states(config) {
    return Object.fromEntries(inspectors.map(inspector => {
      let result = config.results?.[inspector];
      // Existing combined results remain readable until independently replaced.
      if (!config.results && config.result?.fingerprint) {
        try {
          const inputs = JSON.parse(config.result.fingerprint);
          result = { ...config.result, repository: inputs.repository, filename: 'analysis.sqlite', fingerprint: fingerprint(inputs, inspector) };
        } catch { /* An unknown legacy fingerprint cannot establish provenance. */ }
      }
      const hasResults = !!result && result.repository === config.repository && usable(this.path(config.id, result.filename), inspector);
      return [inspector, { hasResults, stale: hasResults && result.fingerprint !== fingerprint(config, inspector), result: hasResults ? result : null }];
    }));
  }
  // Only consumers combine measurements. Each immutable source pair owns its score cache.
  analysis(config) {
    const states = this.states(config);
    check(states.code.hasResults, 'Run Code inspection to generate results.');
    const code = states.code.result, git = states.git.result;
    const key = createHash('sha256').update(JSON.stringify([code.filename, git?.filename])).digest('hex');
    const path = this.path(config.id, `analysis-${key}.sqlite`);
    if (usable(path)) return path;
    const staging = this.path(config.id, `analysis-${randomUUID()}.pending.sqlite`);
    let db;
    try {
      db = new DatabaseSync(staging);
      const quote = name => `"${name.replaceAll('"', '""')}"`;
      for (const [kind, result] of [['code', code], ['git', git]]) {
        if (!result) continue;
        db.prepare(`ATTACH DATABASE ? AS source_${kind}`).run(this.path(config.id, result.filename));
        const schema = db.prepare(`SELECT type,name,sql FROM source_${kind}.sqlite_master WHERE name GLOB '${kind}_*' AND sql IS NOT NULL`).all();
        db.exec('BEGIN');
        for (const table of schema.filter(row => row.type === 'table')) {
          db.exec(table.sql);
          db.exec(`INSERT INTO ${quote(table.name)} SELECT * FROM source_${kind}.${quote(table.name)}`);
        }
        for (const object of schema.filter(row => row.type !== 'table')) db.exec(object.sql);
        db.exec('COMMIT');
      }
      db.close(); db = null;
      renameSync(staging, path);
      return path;
    } finally { db?.close(); rmSync(staging, { force: true }); }
  }
}
