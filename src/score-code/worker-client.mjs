import { Worker } from 'node:worker_threads';

export function createScoreWorker({ entry = new URL('./worker-entry.mjs', import.meta.url), fieldTimeoutMs = 10000 } = {}) {
  let worker, queue = Promise.resolve(), closed = false;
  function attempt(data) {
    return new Promise((accept, reject) => {
      if (closed) { reject(new Error('Score worker is closed.')); return; }
      if (!worker) {
        const created = new Worker(entry, { execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) });
        worker = created;
        // Keep idle worker errors from becoming unhandled server events.
        const reset = () => { if (worker === created) worker = undefined; };
        created.on('error', reset); created.on('exit', reset);
      }
      const current = worker;
      let active, timer;
      const cleanup = () => { clearTimeout(timer); current.removeListener('message', message); current.removeListener('error', failure); current.removeListener('exit', exit); };
      const arm = delay => { clearTimeout(timer); timer = setTimeout(timeout, delay); };
      const message = result => {
        if (Object.hasOwn(result, 'progress')) { active = result.progress; arm(active ? fieldTimeoutMs : 120000); return; }
        cleanup(); accept(result);
      };
      const failure = error => { cleanup(); worker = undefined; current.terminate(); reject(error); };
      const exit = code => failure(new Error(`Score worker exited: ${code}`));
      const timeout = async () => {
        if (!active || data.editor) { failure(new Error('Calculation timed out.')); return; }
        cleanup(); worker = undefined;
        await current.terminate();
        const key = active.stage === 'aggregation' ? `${active.fieldId}:aggregation` : active.fieldId;
        if (data.blocked?.[key]) { reject(new Error('Calculation exceeded its time limit repeatedly.')); return; }
        const blocked = { ...data.blocked, [key]: `Formula exceeded ${fieldTimeoutMs / 1000}s and was stopped.` };
        attempt({ ...data, blocked }).then(accept, reject);
      };
      current.on('message', message); current.once('error', failure); current.once('exit', exit);
      arm(120000); current.postMessage(data);
    });
  }
  return {
    request(data) { const operation = queue.then(() => attempt(data)); queue = operation.catch(() => {}); return operation; },
    async close() { closed = true; await worker?.terminate(); },
  };
}
