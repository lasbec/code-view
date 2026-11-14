import { DatabaseSync } from 'node:sqlite';
import { minimatch } from '../code-inspector/typescript/node_modules/minimatch/dist/esm/index.js';

import { stronglyConnected } from '../code-inspector/typescript/src/graph.mjs';
export { stronglyConnected };

// Multilevel local modularity optimization. With symmetric edges this is the
// undirected objective; otherwise it preserves separate in/out degrees.
export function communities(ids, edges, resolution = 1, directed = false) {
  let members = ids.map(id => [id]);
  let links = edges.filter(e => e.source !== e.target).map(e => ({ ...e }));
  if (!directed) links = links.flatMap(e => [e, { source: e.target, target: e.source, weight: e.weight }]);
  let labels = [...ids];
  for (let level = 0; level < 12; level++) {
    const index = new Map(labels.map((id, i) => [id, i])), n = labels.length;
    const outgoing = Array.from({ length: n }, () => new Map()), incoming = Array.from({ length: n }, () => new Map());
    const ko = Array(n).fill(0), ki = Array(n).fill(0); let total = 0;
    for (const e of links) {
      const a = index.get(e.source), b = index.get(e.target);
      outgoing[a].set(b, (outgoing[a].get(b) || 0) + e.weight); incoming[b].set(a, (incoming[b].get(a) || 0) + e.weight);
      ko[a] += e.weight; ki[b] += e.weight; total += e.weight;
    }
    if (!total) return members;
    const assignment = Array.from({ length: n }, (_, i) => i), co = [...ko], ci = [...ki];
    for (let pass = 0; pass < 40; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        const old = assignment[i], near = new Map([[old, 0]]);
        for (const map of [outgoing[i], incoming[i]]) for (const [j, w] of map) if (i !== j) near.set(assignment[j], (near.get(assignment[j]) || 0) + w);
        co[old] -= ko[i]; ci[old] -= ki[i];
        const gain = c => (near.get(c) || 0) / total - resolution * (ko[i] * ci[c] + ki[i] * co[c]) / (total * total);
        let best = old, score = gain(old);
        for (const c of [...near.keys()].sort((a,b) => a-b)) { const g = gain(c); if (g > score + 1e-12) { best = c; score = g; } }
        assignment[i] = best; co[best] += ko[i]; ci[best] += ki[i]; if (best !== old) moved = true;
      }
      if (!moved) break;
    }
    const unique = [...new Set(assignment)], next = unique.map(c => members.filter((_, i) => assignment[i] === c).flat().sort());
    if (next.length === n) return next;
    const names = unique.map((_, i) => `level${level}:${i}`), remap = new Map(unique.map((c,i) => [c,names[i]])), sums = new Map();
    for (const e of links) {
      const source = remap.get(assignment[index.get(e.source)]), target = remap.get(assignment[index.get(e.target)]), key = JSON.stringify([source,target]);
      const row = sums.get(key) ?? { source, target, weight: 0 }; row.weight += e.weight; sums.set(key,row);
    }
    members = next; labels = names; links = [...sums.values()];
  }
  return members;
}

export function groupGraph(nodes, edges, c) {
  const ids = nodes.map(n => n.id).sort(), cycles = stronglyConnected(ids, edges);
  const cyclic = cycles.filter(g => g.length > 1 || c.selfLoops && edges.some(e => e.source === g[0] && e.target === g[0]));
  const cycleById = new Map(cyclic.flatMap((g,i) => g.map(id => [id, i])));
  let serial = 0;
  function build(set, depth, forceCycle = false) {
    const chosen = new Set(set), inside = edges.filter(e => chosen.has(e.source) && chosen.has(e.target));
    const partitions = c.mode === 'cycles' ? stronglyConnected(set, inside) : communities(set, inside, c.resolution * (1 + (depth - 1) * .5), c.directed);
    return partitions.flatMap(part => {
      if (part.length < c.minGroup) return part.map(id => ({ id, members: [id], cycle: cycleById.has(id) }));
      const cycle = forceCycle || part.every(id => cycleById.has(id) && cycleById.get(id) === cycleById.get(part[0]));
      const children = c.mode === 'clusters' && c.nested && depth < c.maxDepth && part.length > c.targetSize ? build(part, depth + 1) : part.map(id => ({ id, members: [id], cycle: cycleById.has(id) }));
      return [{ id: `group:${serial++}`, label: `${c.mode === 'cycles' ? 'Cycle' : 'Cluster'} · ${part.length}`, members: part, cycle, children: children.length === 1 && children[0].members.length === part.length ? (children[0].children ?? children) : children }];
    });
  }
  return { groups: build(ids, 1), cycleCount: cyclic.length };
}
export function readGraph(path, c) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const rows = table => tables.has(table) ? db.prepare(`SELECT * FROM ${table}`).all() : [];
    const files = rows('code_files'), functions = rows('code_functions'), byFn = new Map(functions.map(f => [f.id,f]));
    const matches = file => (!c.include.length || c.include.some(p => minimatch(file,p,{dot:true}))) && !c.exclude.some(p => minimatch(file,p,{dot:true}));
    const nodes = (c.level === 'file' ? files.map(f => ({id:f.id,label:f.id,file:f.id,kind:'file'})) : functions.map(f => ({id:f.id,label:f.name,file:f.file_id,line:f.line,kind:'function'}))).filter(n => matches(n.file));
    const available = new Set(nodes.map(n => n.id)), sums = new Map(); let unresolved = 0, outside = 0;
    function add(source,target,evidence) {
      if (!available.has(source)) return;
      if (!target) { unresolved++; return; }
      if (!available.has(target)) { outside++; return; }
      if (source === target && (c.level === 'file' || !c.selfLoops)) return;
      const key = JSON.stringify([source,target]), edge = sums.get(key) ?? { source,target,count:0,evidence:[] };
      edge.count++; if (edge.evidence.length < 100) edge.evidence.push(evidence); sums.set(key,edge);
    }
    if (c.relation === 'imports') for (const r of rows('code_imports')) add(r.file_id,r.target_file_id,{file:r.file_id,line:r.line,kind:r.kind,name:r.specifier});
    if (c.relation === 'calls') for (const r of rows('code_calls')) add(c.level === 'file' ? r.file_id : r.caller_id, r.resolution === 'resolved' ? (c.level === 'file' ? byFn.get(r.target_id)?.file_id : r.target_id) : null,{file:r.file_id,line:r.line,kind:r.kind,name:r.target_name});
    if (c.relation === 'references') {
      for (const r of rows('code_function_references')) add(c.level === 'file' ? r.file_id : r.function_id,c.level === 'file' ? byFn.get(r.target_id)?.file_id : r.target_id,{file:r.file_id,line:r.line,kind:r.kind,name:r.target_name});
      if (c.level === 'file') for (const r of rows('code_symbol_references')) add(r.file_id,r.target_file_id,{file:r.file_id,line:r.line,kind:r.kind,name:r.target_name});
    }
    const edges = [...sums.values()].map(e => ({ ...e, weight: c.weighting === 'binary' ? 1 : c.weighting === 'log' ? Math.log1p(e.count) : e.count }));
    const warnings = [];
    if (c.relation === 'imports') { if (!tables.has('code_imports')) warnings.push('Run inspection again to collect imports.'); warnings.push('Imports include type imports; type and runtime dependencies are not separated.'); }
    if (c.level === 'function') warnings.push('Module-scope uses have no owning function and are excluded.');
    if (unresolved || outside) warnings.push(`${unresolved} unresolved and ${outside} external or excluded occurrences cannot be followed.`);
    if (c.include.length || c.exclude.length) warnings.push('Groups are calculated only within the selected paths; paths outside this scope may close additional cycles.');
    return { nodes,edges,...groupGraph(nodes,edges,c),warnings };
  } finally { db.close(); }
}
