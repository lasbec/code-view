import { spawn } from 'node:child_process';
import { mkdir, rename, rm, realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { waitingProgress, progressStream } from './progress.mjs';
import { check } from './store.mjs';
import { Results, inspectors, usable, fingerprint } from './results.mjs';
export { usable, fingerprint } from './results.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
export class Jobs extends Results {
  constructor(directory, store) { super(directory); this.store = store; this.tasks = new Map(); }
  get list() { return [...this.tasks.values()].map(({ job }) => structuredClone(job)); }
  get done() { return Promise.all([...this.tasks.values()].map(task => task.done)); }
  running(id) { return this.list.some(job => job.id === id && job.status === 'running'); }
  stopChild(task, signal) {
    if (!task.child) return;
    try {
      if (process.platform === 'win32') task.child.kill(signal);
      else process.kill(-task.child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  cancel(id, inspector) {
    for (const task of this.tasks.values()) if ((!id || task.job.id === id) && (!inspector || task.job.inspector === inspector) && task.job.status === 'running') {
      task.job.cancelled = true; this.stopChild(task, 'SIGTERM');
    }
  }
  async command(task, command, args, capture = false, reportProgress = false) {
    const { job } = task;
    if (job.cancelled) throw new Error('Inspection cancelled.');
    return new Promise((accept, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      task.child = child;
      let output = '';
      const append = chunk => {
        const text = chunk.toString(); output = (output + text).slice(-100000);
        if (!capture) job.log = (job.log + text).slice(-100000);
      };
      const progress = reportProgress ? progressStream(event => { if (!job.cancelled) job.progress = event; }, append) : null;
      child.stdout.on('data', append);
      child.stderr.on('data', chunk => progress ? progress.write(chunk) : append(chunk));
      child.stderr.on('end', () => progress?.end());
      const timer = setInterval(() => { if (job.cancelled) this.stopChild(task, 'SIGKILL'); }, 2000);
      child.once('error', error => { clearInterval(timer); task.child = null; reject(error); });
      child.once('close', code => { clearInterval(timer); task.child = null; code === 0 && !job.cancelled ? accept(output.trim()) : reject(new Error(job.cancelled ? 'Inspection cancelled.' : `${command} exited with code ${code}.\n${output}`)); });
    });
  }
  start(config, inspector = 'both') {
    check([...inspectors, 'both'].includes(inspector), 'Choose code, git or both.');
    const selected = inspector === 'both' ? inspectors : [inspector];
    for (const kind of selected) check(this.tasks.get(`${config.id}:${kind}`)?.job.status !== 'running', `${kind} inspection is already running.`);
    return selected.map(kind => {
      const task = { job: { id: config.id, name: config.name, inspector: kind, progress: waitingProgress(), status: 'running', phase: 'Checking repository', startedAt: new Date().toISOString(), log: '', cancelled: false }, child: null };
      this.tasks.set(`${config.id}:${kind}`, task);
      task.done = this.run(structuredClone(config), task);
      return structuredClone(task.job);
    });
  }
  async run(config, task) {
    const { job } = task, kind = job.inspector;
    const filename = `${kind}-${randomUUID()}.sqlite`, staging = this.path(config.id, `${filename}.pending`);
    let published = false;
    const command = (program, args, capture = false, progress = false) => this.command(task, program, args, capture, progress);
    try {
      await mkdir(resolve(this.directory, config.id), { recursive: true });
      const repository = await realpath(config.repository);
      const root = await command('git', ['-C', repository, 'rev-parse', '--show-toplevel'], true);
      check(await realpath(root) === repository, 'Choose the repository root directory.');
      let head = await command('git', ['-C', repository, 'rev-parse', 'HEAD'], true);
      const branch = await command('git', ['-C', repository, 'symbolic-ref', '--quiet', '--short', 'HEAD'], true);
      job.branch = branch;
      const dirty = !!await command('git', ['-C', repository, 'status', '--porcelain'], true);
      job.progress.status = 'preparing';
      if (kind === 'code') {
        const tsconfig = await realpath(resolve(repository, config.tsconfig));
        const rel = relative(repository, tsconfig);
        check(rel !== '..' && !rel.startsWith(`..${sep}`), 'tsconfig resolves outside the repository.');
        job.phase = 'Inspecting TypeScript';
        await command(process.execPath, [resolve(source, 'code-inspector/typescript/src/main.mjs'), '--progress', '--repository', repository, '--tsconfig', tsconfig, '--output', staging, ...config.include.flatMap(p => ['--include', p]), ...config.exclude.flatMap(p => ['--exclude', p])], false, true);
      } else {
        const commits = config.commits ?? Number(await command('git', ['-C', repository, 'rev-list', '--count', head, '--'], true));
        job.phase = 'Inspecting Git history';
        await command('python3', [resolve(source, 'git-inspector/git_inspector.py'), '--progress', '--repo', repository, '--branch', branch, '--commits', String(commits), '--mode', 'replace', '--output', staging], false, true);
      }
      job.phase = 'Publishing results';
      check(usable(staging, kind), 'Inspector did not produce a usable database.');
      if (job.cancelled) throw new Error('Inspection cancelled.');
      if (kind === 'git') {
        const db = new DatabaseSync(staging, { readOnly: true });
        try { head = db.prepare('SELECT tip_hash FROM git_branches WHERE name=?').get(branch).tip_hash; } finally { db.close(); }
      }
      const result = { filename, repository: config.repository, fingerprint: fingerprint(config, kind), completedAt: new Date().toISOString(), branch, head, dirty };
      await rename(staging, this.path(config.id, filename));
      published = await this.store.update(s => {
        const c = s.inspections.find(c => c.id === config.id);
        // A repository switch retires even a still-running result from the old association.
        if (!c || c.repository !== config.repository || c.repositoryGeneration !== config.repositoryGeneration) return false;
        if (job.cancelled) throw new Error('Inspection cancelled.');
        const prior = Object.fromEntries(Object.entries(this.states(c)).filter(([, state]) => state.hasResults).map(([key, state]) => [key, state.result]));
        c.results = { ...prior, [kind]: result }; delete c.result;
        return true;
      });
      job.progress.status = 'done'; job.status = 'succeeded';
      job.phase = published ? 'Inspection complete' : 'Result discarded after repository change';
    } catch (error) {
      job.status = job.cancelled ? 'cancelled' : 'failed'; job.error = error.message; job.progress.status = job.status;
    } finally {
      if (!published) await rm(this.path(config.id, filename), { force: true }).catch(() => {});
      await rm(staging, { force: true }).catch(() => {});
      job.finishedAt = new Date().toISOString();
    }
  }
}
