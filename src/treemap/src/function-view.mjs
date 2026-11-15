import { aggregate } from './scoring.mjs';

// All source queries use fixed, catalog-owned SQL. File-only metrics never enter
// function scoring. Events use their owning function, or their target for incoming references.
export function attachFunctions(db, files, selected, catalog, query) {
  const columns = table => new Set(query(db, `PRAGMA table_info(${table})`).map(c => c.name));
  if (!columns('code_files').has('outside_size_bytes') || !['exclusive_size_bytes', 'exclusive_effective_lines'].every(c => columns('code_functions').has(c))) {
    throw new Error('Function view requires a new inspection run to measure exclusive function sizes.');
  }
  if (!catalog.has(selected.functionArea)) throw new Error('Function size metric is unavailable. Run inspection again.');
  const fileById = new Map(files.map(file => [file.id, file]));
  const functions = query(db, 'SELECT id,file_id,name,kind,line,column,end_line,exclusive_size_bytes FROM code_functions').filter(fn => fileById.has(fn.file_id));
  const measurements = new Map(functions.map(fn => [fn.id, new Map()]));
  const needed = new Set([selected.functionArea]);
  for (const metric of needed) {
    const source = catalog.get(metric);
    const owner = source.functionOwner ?? (source.table === 'code_functions' ? 't.id' : source.table === 'code_calls' ? 't.caller_id' : 't.function_id');
    for (const row of query(db, `SELECT ${owner} AS owner, ${source.expression} AS value FROM ${source.from}`, source.params)) {
      const values = measurements.get(row.owner);
      if (!values || row.value == null) continue;
      if (!Number.isFinite(row.value)) throw new Error(`Invalid function measurement: ${metric}`);
      if (!values.has(metric)) values.set(metric, []);
      values.get(metric).push(row.value);
    }
  }
  for (const file of files) { file.kind = 'file'; file.children = []; }
  const nodes = functions.map(fn => {
    const file = fileById.get(fn.file_id), values = measurements.get(fn.id);
    const node = { ...fn, kind: 'function', functionKind: fn.kind, path: `${file.path}:${fn.line}:${fn.column}`, sizeMetric: catalog.get(selected.functionArea).label, metrics: {}, scores: [] };
    for (const metric of needed) node.metrics[metric] = aggregate(values.get(metric) ?? [], catalog.get(metric).aggregation);
    file.children.push(node);
    return node;
  });
  const sizes = new Map(query(db, 'SELECT id,size_bytes,outside_size_bytes FROM code_files').map(file => [file.id, file]));
  for (const file of files) {
    const size = sizes.get(file.id);
    if (!Number.isFinite(size.outside_size_bytes) || size.outside_size_bytes < 0 || file.children.some(fn => !Number.isFinite(fn.exclusive_size_bytes) || fn.exclusive_size_bytes < 0)) throw new Error('Incomplete function sizes. Run inspection again.');
    const outsideArea = file.children.length ? file.area * Math.min(1, size.outside_size_bytes / Math.max(1, size.size_bytes)) : file.area;
    let weights = file.children.map(fn => Math.max(0, fn.metrics[selected.functionArea]));
    if (!weights.some(value => value > 0)) weights = file.children.map(fn => fn.exclusive_size_bytes);
    const largest = aggregate(weights, 'max');
    // Reserve at most 0.5% of function space across zero-sized functions.
    const floor = Math.max(largest, 1) * 0.005 / Math.max(1, weights.length);
    weights = weights.map(value => Math.max(value, floor));
    const total = aggregate(weights, 'sum');
    file.children.forEach((fn, index) => { fn.area = (file.area - outsideArea) * weights[index] / total; });
    if (outsideArea > 0) file.children.push({ name: 'Outside functions', path: `${file.path}:outside`, kind: 'outside', area: outsideArea, heat: null, scores: [], metrics: {}, color: '#c9d0d8' });
  }
  return nodes;
}
