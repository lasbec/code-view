import { argumentUsage } from './argument-usage.mjs';
import { stronglyConnected } from './graph.mjs';

// SCCs share their transitive sets. Kosaraju returns components in topological
// order, so downstream summaries and depths are ready before their callers.
export function dependencies(functions, calls, external = [], unknown = [], { stateBudget = 1000000, depthBudget = 5120 } = {}) {
  const ids = functions.map(f => f.id), available = new Set(ids);
  const edges = calls.filter(c => available.has(c.caller_id) && available.has(c.target_id)).map(c => ({ source: c.caller_id, target: c.target_id }));
  const out = new Map(ids.map(id => [id, new Set()]));
  for (const e of edges) out.get(e.source).add(e.target);
  const components = stronglyConnected(ids, edges), componentOf = new Map(components.flatMap((g, i) => g.map(id => [id, i])));
  const direct = new Map(ids.map(id => [id, new Set()])), missing = new Set(unknown.map(r => r.function_id));
  const missingCalls = new Set(unknown.filter(r => ['unresolved_call', 'excluded_internal'].includes(r.reason)).map(r => r.function_id));
  for (const c of calls) if (available.has(c.caller_id) && !available.has(c.target_id) && c.resolution !== 'external') { missing.add(c.caller_id); missingCalls.add(c.caller_id); }
  for (const r of external) direct.get(r.function_id)?.add(r.symbol_id);
  const groups = [], metrics = new Map();
  for (let i = components.length - 1; i >= 0; i--) {
    const members = components[i], cyclic = members.length > 1 || out.get(members[0]).has(members[0]);
    const reachable = new Set(cyclic ? members : []), symbols = new Set();
    let complete = !members.some(id => missing.has(id));
    let callsComplete = !members.some(id => missingCalls.has(id));
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
      callsComplete &&= g.callsComplete;
    }
    groups[i] = { id: String(i), functions: [...reachable].sort(), symbols: [...symbols].sort(), complete, callsComplete };
    // A simple path visits each remaining member at most once, then exits once.
    // Unknown downstream depths disable pruning rather than imply a finite bound.
    let exitDepth = 0;
    for (const id of members) for (const next of out.get(id)) {
      if (componentOf.get(next) !== i) {
        const value = metrics.get(next).call_depth;
        exitDepth = Math.max(exitDepth, value == null ? Infinity : 1 + value);
      }
    }
    const index = new Map(members.map((id, j) => [id, BigInt(j)])), memo = new Map();
    let states = 0, minimum = 0;
    function depth(id, mask) {
      // Explicit frames honor the search-depth budget independently of the JS stack.
      function frame(id, mask, level) {
        const key = `${id}/${mask}`;
        if (++states > stateBudget || level > depthBudget) throw new Error('depth budget');
        return { id, mask, level, key, next: [...out.get(id)], cursor: 0, best: 0 };
      }
      const key = `${id}/${mask}`;
      if (memo.has(key)) return memo.get(key);
      const stack = [frame(id, mask, 0)];
      while (stack.length) {
        const top = stack.at(-1);
        minimum = Math.max(minimum, top.level + top.best);
        if (top.cursor === top.next.length || top.best === members.length - 1 - top.level + exitDepth) {
          memo.set(top.key, top.best); stack.pop();
          if (stack.length) stack.at(-1).best = Math.max(stack.at(-1).best, 1 + top.best);
          continue;
        }
        const next = top.next[top.cursor++];
        if (componentOf.get(next) !== i) {
          const value = metrics.get(next).call_depth;
          minimum = Math.max(minimum, top.level + 1 + metrics.get(next).depth_lower_bound);
          if (value == null) throw new Error('downstream depth unavailable');
          top.best = Math.max(top.best, 1 + value);
        } else {
          const bit = 1n << index.get(next);
          if (top.mask & bit) continue;
          const nextMask = top.mask | bit, nextKey = `${next}/${nextMask}`;
          if (memo.has(nextKey)) top.best = Math.max(top.best, 1 + memo.get(nextKey));
          else stack.push(frame(next, nextMask, top.level + 1));
        }
      }
      return memo.get(key);
    }
    for (const id of members) {
      let value = null;
      minimum = 0;
      for (const next of out.get(id)) {
        if (componentOf.get(next) !== i) minimum = Math.max(minimum, 1 + metrics.get(next).depth_lower_bound);
        else if (next !== id) minimum = Math.max(minimum, 1);
      }
      try { value = depth(id, 1n << index.get(id)); } catch { /* Exact depth unavailable; counts remain usable. */ }
      metrics.set(id, { call_depth: value, depth_lower_bound: value ?? minimum, reachable_internal_count: reachable.size, reachable_external_count: symbols.size, reachable_symbol_count: reachable.size + symbols.size, direct_external_count: direct.get(id).size, dependency_complete: Number(complete), call_graph_complete: Number(callsComplete), direct_external_complete: Number(!missing.has(id)), dependency_group_id: String(i) });
    }
  }
  return { groups, metrics };
}
export function finalizeDependencies(db, result) {
  const argumentsByFunction = argumentUsage(result.functions, result.calls, result.argumentUsages, result.unknownReferences);
  const { groups, metrics } = dependencies(result.functions, result.calls, result.externalReferences, result.unknownReferences);
  // Down depth follows only the original, directly resolved call edges. Reuse the
  // calculation when callback inference has not added any edges.
  const down = result.calls.some(c => c.is_inferred)
    ? dependencies(result.functions, result.calls.filter(c => !c.is_inferred)).metrics : metrics;
  const group = db.prepare('INSERT INTO code_dependency_groups VALUES (?,?,?,?)');
  for (const g of groups) group.run(g.id, JSON.stringify(g.functions), JSON.stringify(g.symbols), Number(g.complete));
  const fields = ['function_argument_usage_internal', 'function_argument_usage_external', 'minimum_function_argument_usage_internal', 'minimum_function_argument_usage_external', 'function_argument_usage_complete', 'call_depth', 'down_call_depth', 'reachable_internal_count', 'reachable_external_count', 'reachable_symbol_count', 'direct_external_count', 'dependency_complete', 'call_graph_complete', 'direct_external_complete', 'dependency_group_id'];
  const update = db.prepare(`UPDATE code_functions SET ${fields.map(f => `${f}=?`).join(',')} WHERE id=?`);
  for (const f of result.functions) {
    const { depth_lower_bound, ...values } = metrics.get(f.id);
    Object.assign(f, values, argumentsByFunction.get(f.id), { down_call_depth: down.get(f.id).depth_lower_bound });
    update.run(...fields.map(k => f[k]), f.id);
  }
}
