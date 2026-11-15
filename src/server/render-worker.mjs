import { developerData } from './developers.mjs';
import { inspectionList } from './inspection-list.mjs';
import { serveScoreWorker } from '../score-code/worker.mjs';
import { readFile } from 'node:fs/promises';
import { calculateTreeMap, renderTreeMap, listMetrics } from '../treemap/src/index.mjs';
serveScoreWorker(async workerData => {
  workerData.preset.options.scoreData = workerData.scoreData;
  const bytes = await readFile(workerData.path);
  if (workerData.list) {
    const functions = Map.groupBy(workerData.scoreData.functions, fn => fn.file_id);
    const model = { files: workerData.scoreData.files.map(file => ({ ...file, heat: file.score, children: (functions.get(file.id) ?? []).map(fn => ({...fn,kind:'function',heat:fn.score})) })),
      diagnostics: [...workerData.scoreData.files,...workerData.scoreData.functions].filter(item=>item.error).map(item=>({severity:'warning',message:`${item.id}: ${item.error}`})) };
    const list = inspectionList(workerData.path, model);
    return (workerData.list === 'developers' ? developerData(workerData.path, list.files, workerData.preset.developerPreset, workerData.preset.options.authorIdentities, workerData.preset.options) : list);
  } else {
  const metrics = await listMetrics(bytes);
  const result = await calculateTreeMap(bytes, workerData.preset.config, workerData.preset.options);
  const expanded = workerData.detail ? await calculateTreeMap(bytes, workerData.preset.config, { ...workerData.preset.options, showFunctions: true }) : result;
  if (result.ok && workerData.preset.developerPreset) {
    const all = await calculateTreeMap(bytes, workerData.preset.config, { ...workerData.preset.options, includeZeroArea: true, showFunctions: true });
    if (!all.ok) throw new Error(all.diagnostics.map(d => d.message).join(' '));
    const data = developerData(workerData.path, inspectionList(workerData.path, all).files, workerData.preset.developerPreset, workerData.preset.options.authorIdentities, workerData.preset.options);
    const palette = ['#0072b2','#e66100','#009e73','#cc3377','#e6b800','#6633bb','#00a6b2','#b52b28','#668800','#aa4499','#336633','#996633'];
    const ids = Object.keys(data.authorship).flatMap(path => data.authorship[path].authors.map(a => a.id));
    const colors = new Map([...new Set(ids)].sort().map((id, i) => [id, palette[i] ?? `hsl(${(i * 137.508) % 360} 80% ${i % 2 ? 40 : 60}%)`]));
    const annotate = (node, inherited) => {
      const authorship = data.authorship[node.path ?? node.id] ?? inherited;
      if (authorship) {
        node.authorship = { ...authorship, authors: authorship.authors.map(a => ({ ...a, color: colors.get(a.id) })) };
        node.mainAuthor = node.authorship.authors[0];
      }
      for (const child of node.children ?? []) annotate(child, node.kind === 'file' ? authorship : undefined);
    };
    annotate(result.tree);
    for (const file of result.files) annotate(file);
    if (expanded !== result && expanded.ok) { annotate(expanded.tree); for (const file of expanded.files) annotate(file); }
    result.authors = [...new Map(Object.values(data.mainAuthors).map(a => [a.id,{ ...a, color: colors.get(a.id) }])).values()];
  }
  return ({ ...renderTreeMap(result), metrics, ...(workerData.detail ? { model: result, expanded } : {}), ok: result.ok, diagnostics: result.diagnostics });
  }
});
