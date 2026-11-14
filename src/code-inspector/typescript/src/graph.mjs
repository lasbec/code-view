// Iterative Kosaraju avoids exhausting the stack on large call graphs.
export function stronglyConnected(ids, edges) {
  const out = new Map(ids.map(id => [id, []])), incoming = new Map(ids.map(id => [id, []]));
  for (const e of edges) { out.get(e.source)?.push(e.target); incoming.get(e.target)?.push(e.source); }
  const seen = new Set(), order = [];
  for (const root of ids) {
    if (seen.has(root)) continue;
    seen.add(root); const stack = [[root, 0]];
    while (stack.length) {
      const top = stack.at(-1), next = out.get(top[0]);
      if (top[1] < next.length) { const id = next[top[1]++]; if (!seen.has(id)) { seen.add(id); stack.push([id, 0]); } }
      else { order.push(top[0]); stack.pop(); }
    }
  }
  seen.clear(); const groups = [];
  for (const root of order.reverse()) {
    if (seen.has(root)) continue;
    const group = [], stack = [root]; seen.add(root);
    while (stack.length) { const id = stack.pop(); group.push(id); for (const next of incoming.get(id)) if (!seen.has(next)) { seen.add(next); stack.push(next); } }
    groups.push(group.sort());
  }
  return groups;
}

