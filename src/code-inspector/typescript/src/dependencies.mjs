import { stronglyConnected } from './graph.mjs';

// SCCs share their transitive sets. Kosaraju returns components in topological
// order, so downstream summaries and depths are ready before their callers.
export function dependencies(functions, calls, external = [], unknown = [], { stateBudget = 100000 } = {}) {
  const ids = functions.map(f => f.id), available = new Set(ids);
  const edges = calls.filter(c => available.has(c.caller_id) && available.has(c.target_id)).map(c => ({ source: c.caller_id, target: c.target_id }));
  const out = new Map(ids.map(id => [id, new Set()]));
  for (const e of edges) out.get(e.source).add(e.target);
  const components = stronglyConnected(ids, edges), componentOf = new Map(components.flatMap((g, i) => g.map(id => [id, i])));
  const direct = new Map(ids.map(id => [id, new Set()])), missing = new Set(unknown.map(r => r.function_id));
  for (const c of calls) if (available.has(c.caller_id) && !available.has(c.target_id) && c.resolution !== 'external') missing.add(c.caller_id);
  for (const r of external) direct.get(r.function_id)?.add(r.symbol_id);
  const groups = [], metrics = new Map();
  for (let i = components.length - 1; i >= 0; i--) {
    const members = components[i], cyclic = members.length > 1 || out.get(members[0]).has(members[0]);
    const reachable = new Set(cyclic ? members : []), symbols = new Set();
    let complete = !members.some(id => missing.has(id));
    const children = new Set();
    for (const id of members) {
      for (const s of direct.get(id)) symbols.add(s);
      for (const next of out.get(id)) if (componentOf.get(next) !== i) { reachable.add(next); children.add(componentOf.get(next)); }
    }
    for (const child of children) {
      const g = groups[child];
      for (const id of g.functions) reachable.add(id);
      for (const s of g.symbols) symbols.add(s);
      complete &&= g.complete;
    }
    groups[i] = { id: String(i), functions: [...reachable].sort(), symbols: [...symbols].sort(), complete };
    const index = new Map(members.map((id, j) => [id, BigInt(j)])), memo = new Map();
    let states = 0;
    function depth(id, mask, level = 0) {
      const key = `${id}/${mask}`;
      if (memo.has(key)) return memo.get(key);
      if (++states > stateBudget || level > 512) throw new Error('depth budget');
      let best = 0;
      for (const next of out.get(id)) {
        if (componentOf.get(next) !== i) {
          const value = metrics.get(next).call_depth;
          if (value == null) throw new Error('downstream depth unavailable');
          best = Math.max(best, 1 + value);
        } else {
          const bit = 1n << index.get(next);
          if (!(mask & bit)) best = Math.max(best, 1 + depth(next, mask | bit, level + 1));
        }
      }
      memo.set(key, best); return best;
    }
    for (const id of members) {
      let value = null;
      try { value = depth(id, 1n << index.get(id)); } catch { /* Exact depth unavailable; counts remain usable. */ }
      metrics.set(id, { call_depth: value, reachable_internal_count: reachable.size, reachable_external_count: symbols.size, reachable_symbol_count: reachable.size + symbols.size, direct_external_count: direct.get(id).size, dependency_complete: Number(complete), dependency_group_id: String(i) });
    }
  }
  return { groups, metrics };
}
export function finalizeDependencies(db, result) {
  const { groups, metrics } = dependencies(result.functions, result.calls, result.externalReferences, result.unknownReferences);
  const group = db.prepare('INSERT INTO code_dependency_groups VALUES (?,?,?,?)');
  for (const g of groups) group.run(g.id, JSON.stringify(g.functions), JSON.stringify(g.symbols), Number(g.complete));
  const fields = ['call_depth', 'reachable_internal_count', 'reachable_external_count', 'reachable_symbol_count', 'direct_external_count', 'dependency_complete', 'dependency_group_id'];
  const update = db.prepare(`UPDATE code_functions SET ${fields.map(f => `${f}=?`).join(',')} WHERE id=?`);
  for (const f of result.functions) { Object.assign(f, metrics.get(f.id)); update.run(...fields.map(k => f[k]), f.id); }
}
