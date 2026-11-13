import { inspectionList } from './inspection-list.mjs';
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { calculateTreeMap, renderTreeMap, listMetrics } from '../treemap/src/index.mjs';
try {
  const bytes = await readFile(workerData.path);
  if (workerData.list) {
    const model = await calculateTreeMap(bytes, workerData.preset.config, workerData.preset.options);
    if (!model.ok) throw new Error(model.diagnostics.map(d => d.message).join(' '));
    parentPort.postMessage(inspectionList(workerData.path, model));
  } else {
  const metrics = await listMetrics(bytes);
  const result = await calculateTreeMap(bytes, workerData.preset.config, workerData.preset.options);
  const expanded = workerData.detail ? await calculateTreeMap(bytes, workerData.preset.config, { ...workerData.preset.options, include: [], exclude: [], showFunctions: true }) : result;
  parentPort.postMessage({ ...renderTreeMap(result), metrics, ...(workerData.detail ? { model: result, expanded } : {}), ok: result.ok, diagnostics: result.diagnostics });
  }
} catch (error) { parentPort.postMessage({ error: error.message }); }
