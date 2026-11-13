import { developerData } from './developers.mjs';
import { inspectionList } from './inspection-list.mjs';
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { calculateTreeMap, renderTreeMap, listMetrics } from '../treemap/src/index.mjs';
try {
  const bytes = await readFile(workerData.path);
  if (workerData.list) {
    const model = await calculateTreeMap(bytes, workerData.preset.config, workerData.preset.options);
    if (!model.ok) throw new Error(model.diagnostics.map(d => d.message).join(' '));
    const list = inspectionList(workerData.path, model);
    parentPort.postMessage(workerData.list === 'developers' ? developerData(workerData.path, list.files, workerData.preset.developerPreset, workerData.preset.options.authorIdentities, workerData.preset.options) : list);
  } else {
  const metrics = await listMetrics(bytes);
  const result = await calculateTreeMap(bytes, workerData.preset.config, workerData.preset.options);
  if (result.ok && workerData.preset.developerPreset) {
    const all = await calculateTreeMap(bytes, workerData.preset.config, { ...workerData.preset.options, include: [], exclude: [], includeZeroArea: true, showFunctions: true });
    if (!all.ok) throw new Error(all.diagnostics.map(d => d.message).join(' '));
    const data = developerData(workerData.path, inspectionList(workerData.path, all).files, workerData.preset.developerPreset, workerData.preset.options.authorIdentities, workerData.preset.options);
    const annotate = node => {
      const author = data.mainAuthors[node.path ?? node.id];
      if (node.kind === 'file' || author) node.mainAuthor = author ?? null;
      for (const child of node.children ?? []) { if (author) child.mainAuthor = author; annotate(child); }
    };
    annotate(result.tree);
    result.authors = [...new Map(Object.values(data.mainAuthors).map(a => [a.id,a])).values()];
  }
  const expanded = workerData.detail ? await calculateTreeMap(bytes, workerData.preset.config, { ...workerData.preset.options, include: [], exclude: [], showFunctions: true }) : result;
  parentPort.postMessage({ ...renderTreeMap(result), metrics, ...(workerData.detail ? { model: result, expanded } : {}), ok: result.ok, diagnostics: result.diagnostics });
  }
} catch (error) { parentPort.postMessage({ error: error.message }); }
