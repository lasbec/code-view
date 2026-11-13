export function solveTermination(functions, calls) {
  const byId = new Map(functions.map(f => [f.id, f]));
  const outgoing = new Map(), incoming = new Map(), remaining = new Map(), proven = new Set(), queue = [];
  for (const c of calls) {
    if (!c.caller_id) continue;
    if (!outgoing.has(c.caller_id)) outgoing.set(c.caller_id, []);
    outgoing.get(c.caller_id).push(c.target_id);
    if (c.target_id) {
      if (!incoming.has(c.target_id)) incoming.set(c.target_id, []);
      incoming.get(c.target_id).push(c.caller_id);
    }
  }
  for (const f of functions) {
    const edges = outgoing.get(f.id) ?? [];
    remaining.set(f.id, edges.length);
    if (f.termination_candidate && !edges.length) { proven.add(f.id); queue.push(f.id); }
  }
  for (let i = 0; i < queue.length; i++) {
    for (const caller of incoming.get(queue[i]) ?? []) {
      remaining.set(caller, remaining.get(caller) - 1);
      if (byId.get(caller)?.termination_candidate && remaining.get(caller) === 0 && !proven.has(caller)) { proven.add(caller); queue.push(caller); }
    }
  }
  return new Map(functions.map(f => [f.id, {
    termination: proven.has(f.id) ? 'terminates' : 'unknown',
    termination_reason: proven.has(f.id) ? 'No potentially unbounded operations; all direct callees terminate in the structural model.' : 'Loop, suspension, property access, throw, construction, unresolved call or recursive dependency.',
  }]));
}
