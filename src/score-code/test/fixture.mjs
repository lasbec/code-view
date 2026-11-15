import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'score-code-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'analysis.sqlite'), db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE code_metadata(key TEXT,value TEXT);
    INSERT INTO code_metadata VALUES('tsconfig','/repo/tsconfig.json');
    CREATE TABLE code_files(id TEXT PRIMARY KEY,size_bytes INTEGER,total_lines INTEGER,effective_lines INTEGER,outside_size_bytes INTEGER);
    INSERT INTO code_files VALUES('a.ts',100,20,15,10),('b.ts',200,30,25,20),('empty.ts',10,1,1,10);
    CREATE TABLE code_functions(id TEXT PRIMARY KEY,file_id TEXT,name TEXT,kind TEXT,line INTEGER,column INTEGER,end_line INTEGER,cyclomatic_complexity INTEGER,call_depth INTEGER,dependency_complete INTEGER,exclusive_size_bytes INTEGER,exclusive_effective_lines INTEGER);
    INSERT INTO code_functions VALUES('a1','a.ts','first','function',1,1,5,3,2,1,45,5),('a2','a.ts','second','function',6,1,10,7,4,1,45,5),('b1','b.ts','third','function',1,1,8,4,NULL,0,180,20);
    CREATE TABLE code_accesses(function_id TEXT,effect TEXT,mutations INTEGER);
    CREATE TABLE code_parameters(id TEXT,function_id TEXT,mutation_count INTEGER);
    INSERT INTO code_parameters VALUES('p1','a1',2),('p2','a1',5),('p3','a2',1);
    CREATE TABLE git_repositories(id INTEGER,path TEXT);
    INSERT INTO git_repositories VALUES(1,'/repo');
    CREATE TABLE git_commits(repository_id INTEGER,hash TEXT,committed_at TEXT,is_merge INTEGER,author_name TEXT,author_email TEXT);
    INSERT INTO git_commits VALUES(1,'old','2025-01-01T00:00:00Z',0,'Demo','demo@example.com'),(1,'new','2026-01-01T00:00:00Z',0,'Demo','demo@example.com');
    CREATE TABLE git_file_changes(repository_id INTEGER,commit_hash TEXT,path TEXT,churn INTEGER);
    INSERT INTO git_file_changes VALUES(1,'old','a.ts',10),(1,'new','a.ts',20),(1,'new','b.ts',5);
  `);
  return { directory, path, db, bytes: () => readFileSync(path) };
}
export const definition = { fields: [
  { id: 'complexity', kind: 'function', name: 'Complexity', autoName: false, code: 'metrics.cyclomatic_complexity * 2', aggregation: 'sum(scores)' },
  { id: 'peak', kind: 'function', name: 'Peak', autoName: false, code: 'metrics.cyclomatic_complexity', aggregation: 'max(scores) ?? 0' },
  { id: 'churn', kind: 'file', name: 'Churn', autoName: false, code: 'sum(metrics.git_file_changes_churn)' },
] };
