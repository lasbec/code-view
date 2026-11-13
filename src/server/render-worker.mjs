import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { calculateTreeMap, renderTreeMap, listMetrics } from '../treemap/src/index.mjs';
try {
  const bytes = await readFile(workerData.path);
  const metrics = await listMetrics(bytes);
  const result = await calculateTreeMap(bytes, workerData.preset.config, workerData.preset.options);
  const expanded = workerData.detail ? await calculateTreeMap(bytes, workerData.preset.config, { ...workerData.preset.options, include: [], exclude: [], showFunctions: true }) : result;
  parentPort.postMessage({ ...renderTreeMap(result), metrics, ...(workerData.detail ? { model: result, expanded } : {}), ok: result.ok, diagnostics: result.diagnostics });
} catch (error) { parentPort.postMessage({ error: error.message }); }
