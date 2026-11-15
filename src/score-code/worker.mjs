import { parentPort } from 'node:worker_threads';
import { stat } from 'node:fs/promises';
import { ensureScores } from './persistence.mjs';
import { inspectFormula, tools } from './formulas.mjs';
import { formulaMetrics } from './catalog.mjs';

// The server supplies presentation as an adapter; scoring and persistence stay here.
export function serveScoreWorker(present = async request => request.scoreData) {
  parentPort.on('message', async request => {
    try {
      if (request.editor) { parentPort.postMessage({ ...inspectFormula(request.code, request.scope), metrics: formulaMetrics, tools }); return; }
      const generation = await stat(request.path);
      const scoreData = ensureScores(request.path, request.definition, request.filter, progress => parentPort.postMessage({ progress }), request.blocked);
      const current = await stat(request.path);
      if (current.ino !== generation.ino) throw new Error('Inspection changed during calculation. Reload to retry.');
      parentPort.postMessage({ progress: null });
      const result = await present({ ...request, scoreData });
      if ((await stat(request.path)).ino !== generation.ino) throw new Error('Inspection changed during presentation. Reload to retry.');
      parentPort.postMessage(result);
    } catch (error) { parentPort.postMessage({ error: error.message }); }
  });
}
