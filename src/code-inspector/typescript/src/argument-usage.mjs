import { stronglyConnected } from './graph.mjs';

// Union reachable owners rather than paths: each argument position belongs to
// exactly one owner, so diamonds and cycles never multiply its contribution.
export function argumentUsage(functions, calls, usages = [], unknown = []) {
  const ids = functions.map(f => f.id), available = new Set(ids);
  const edges = calls.filter(c => available.has(c.caller_id) && available.has(c.target_id)).map(c => ({ source: c.caller_id, target: c.target_id }));
  const direct = new Map(ids.map(id => [id, { internal: 0, external: 0, complete: true }]));
  for (const u of usages) {
    const value = direct.get(u.function_id);
    if (!value) continue;
    if (u.counted && u.category) value[u.category]++;
    value.complete &&= !!u.complete;
    for (const target of u.targets) if (available.has(target)) edges.push({ source: u.function_id, target });
  }
  for (const c of calls) if (direct.has(c.caller_id) && !available.has(c.target_id) && c.resolution !== 'external') direct.get(c.caller_id).complete = false;
  for (const u of unknown) if (['unresolved_call', 'excluded_internal'].includes(u.reason) && direct.has(u.function_id)) direct.get(u.function_id).complete = false;
  const groups = stronglyConnected(ids, edges), groupOf = new Map(groups.flatMap((members, i) => members.map(id => [id, i])));
  const children = groups.map(() => new Set()), reachable = [], result = new Map();
  for (const { source, target } of edges) if (groupOf.get(source) !== groupOf.get(target)) children[groupOf.get(source)].add(groupOf.get(target));
  for (let i = groups.length - 1; i >= 0; i--) {
    const owners = new Set(groups[i]);
    for (const child of children[i]) for (const id of reachable[child]) owners.add(id);
    reachable[i] = owners;
    let internal = 0, external = 0, complete = true;
    for (const id of owners) {
      const value = direct.get(id);
      internal += value.internal; external += value.external; complete &&= value.complete;
    }
    for (const id of groups[i]) result.set(id, {
      function_argument_usage_internal: complete ? internal : null,
      function_argument_usage_external: complete ? external : null,
      minimum_function_argument_usage_internal: internal,
      minimum_function_argument_usage_external: external,
      function_argument_usage_complete: Number(complete),
    });
  }
  return result;
}
