import { spawn } from 'node:child_process';
import { mkdir, rename, rm, realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { waitingProgress, progressStream } from './progress.mjs';
import { check } from './store.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
export const fingerprint = config => JSON.stringify(Object.fromEntries(['repository', 'tsconfig', 'commits', 'include', 'exclude'].map(k => [k, config[k]])));
export function usable(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    return ['code_files', 'git_repositories', 'git_commits'].every(t => tables.includes(t));
  } catch { return false; } finally { db?.close(); }
}
export class Jobs {
  constructor(directory, store) { this.directory = directory; this.store = store; this.current = null; this.child = null; }
  path(id, filename = 'analysis.sqlite') { return resolve(this.directory, id, filename); }
  stopChild(signal) {
    if (!this.child) return;
    try {
      if (process.platform === 'win32') this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  cancel() { if (this.current?.status === 'running') { this.current.cancelled = true; this.stopChild('SIGTERM'); } }
  async command(command, args, capture = false, inspector = null) {
    if (this.current.cancelled) throw new Error('Inspection cancelled.');
    return new Promise((accept, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      this.child = child;
      let output = '';
      const append = chunk => {
        const text = chunk.toString(); output = (output + text).slice(-100000);
        if (!capture) this.current.log = (this.current.log + text).slice(-100000);
      };
      const progress = inspector && progressStream(event => {
        if (!this.current.cancelled) this.current.progress[inspector] = event;
      }, append);
      child.stdout.on('data', append);
      child.stderr.on('data', chunk => progress ? progress.write(chunk) : append(chunk));
      child.stderr.on('end', () => progress?.end());
      const timer = setInterval(() => { if (this.current.cancelled) this.stopChild('SIGKILL'); }, 2000);
      child.once('error', error => { clearInterval(timer); this.child = null; reject(error); });
      child.once('close', code => { clearInterval(timer); this.child = null; code === 0 && !this.current.cancelled ? accept(output.trim()) : reject(new Error(this.current.cancelled ? 'Inspection cancelled.' : `${command} exited with code ${code}.\n${output}`)); });
    });
  }
  start(config) {
    check(this.current?.status !== 'running', 'An inspection is already running.');
    this.current = { id: config.id, name: config.name, progress: { code: waitingProgress(), git: waitingProgress() }, status: 'running', phase: 'Checking repository', startedAt: new Date().toISOString(), log: '', cancelled: false };
    this.done = this.run(structuredClone(config));
    return this.current;
  }
  async run(config) {
    const staging = this.path(config.id, 'pending.sqlite');
    try {
      await mkdir(resolve(this.directory, config.id), { recursive: true });
      await rm(staging, { force: true });
      const repository = await realpath(config.repository);
      const root = await this.command('git', ['-C', repository, 'rev-parse', '--show-toplevel'], true);
      check(await realpath(root) === repository, 'Choose the repository root directory.');
      const tsconfig = await realpath(resolve(repository, config.tsconfig));
      const rel = relative(repository, tsconfig);
      check(rel !== '..' && !rel.startsWith(`..${sep}`), 'tsconfig resolves outside the repository.');
      const branch = await this.command('git', ['-C', repository, 'symbolic-ref', '--quiet', '--short', 'HEAD'], true);
      this.current.branch = branch;
      const commits = config.commits ?? Number(await this.command('git', ['-C', repository, 'rev-list', '--count', branch, '--'], true));
      this.current.phase = 'Inspecting TypeScript';
      this.current.activeInspector = 'code';
      this.current.progress.code.status = 'preparing';
      await this.command(process.execPath, [resolve(source, 'code-inspector/typescript/src/main.mjs'), '--progress', '--tsconfig', tsconfig, '--output', staging, ...config.include.flatMap(p => ['--include', p]), ...config.exclude.flatMap(p => ['--exclude', p])], false, 'code');
      this.current.progress.code.status = 'done';
      this.current.phase = 'Inspecting Git history';
      this.current.activeInspector = 'git';
      this.current.progress.git.status = 'preparing';
      await this.command('python3', [resolve(source, 'git-inspector/git_inspector.py'), '--progress', '--repo', repository, '--branch', branch, '--commits', String(commits), '--mode', 'replace', '--output', staging], false, 'git');
      this.current.progress.git.status = 'done';
      this.current.activeInspector = null;
      this.current.phase = 'Publishing results';
      check(usable(staging), 'Inspectors did not produce a usable database.');
      if (this.current.cancelled) throw new Error('Inspection cancelled.');
      const result = { fingerprint: fingerprint(config), completedAt: new Date().toISOString(), branch };
      await rename(staging, this.path(config.id));
      await this.store.update(s => { const c = s.inspections.find(c => c.id === config.id); if (c) c.result = result; });
      this.current.status = 'succeeded'; this.current.phase = 'Inspection complete';
    } catch (error) {
      this.current.status = this.current.cancelled ? 'cancelled' : 'failed';
      this.current.error = error.message;
      const active = this.current.activeInspector;
      if (active) this.current.progress[active].status = this.current.status;
    } finally {
      await rm(staging, { force: true }).catch(() => {});
      this.current.finishedAt = new Date().toISOString();
    }
  }
}
