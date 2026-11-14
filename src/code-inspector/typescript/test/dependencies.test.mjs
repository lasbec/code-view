import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dependencies } from '../src/dependencies.mjs';
const graph = (ids, pairs, external = [], unknown = [], options) => dependencies(ids.map(id => ({ id })), pairs.map(([caller_id, target_id]) => ({ caller_id, target_id, resolution: 'resolved' })), external, unknown, options);
test('depth counts cycles without repeats; reachability includes self only on a returning path', () => {
  const { metrics: m } = graph(['A', 'B', 'C', 'R', 'X'], [['B','A'], ['B','C'], ['C','B'], ['R','R']]);
  assert.equal(m.get('A').call_depth, 0);
  assert.equal(m.get('B').call_depth, 1);
  assert.equal(m.get('C').call_depth, 2);
  assert.equal(m.get('B').reachable_internal_count, 3);
  assert.equal(m.get('C').reachable_internal_count, 3);
  assert.equal(m.get('R').call_depth, 0);
  assert.equal(m.get('R').reachable_internal_count, 1);
  assert.equal(m.get('X').reachable_internal_count, 0);
});
test('external sets deduplicate across diamonds and incomplete summaries propagate', () => {
  const { metrics: m } = graph(['a','b','c','d'], [['a','b'],['a','c'],['b','d'],['c','d']], [
    { function_id:'b', symbol_id:'log' }, { function_id:'c', symbol_id:'log' }, { function_id:'d', symbol_id:'env' },
  ], [{function_id:'d'}]);
  assert.equal(m.get('a').reachable_external_count, 2);
  assert.equal(m.get('a').reachable_symbol_count, 5);
  assert.equal(m.get('a').direct_external_count, 0);
  assert.equal(m.get('a').dependency_complete, 0);
  assert.equal(m.get('a').call_depth, 2);
});
test('budget exhaustion preserves exact counts and leaves depth unknown', () => {
  const {metrics:m}=graph(['a','b','c'],[['a','b'],['b','a'],['c','a']],[],[],{stateBudget:0});
  assert.equal(m.get('a').call_depth,null);
  assert.equal(m.get('c').call_depth,null);
  assert.equal(m.get('c').reachable_internal_count,2);
  assert.equal(m.get('a').depth_lower_bound,1);
  assert.equal(m.get('c').depth_lower_bound,2);
});
test('memoized SCC depths match exhaustive simple paths on deterministic small graphs', () => {
  let seed=123;
  const random=()=> (seed=(seed*1664525+1013904223)>>>0)/2**32;
  for(let trial=0;trial<100;trial++) {
    const ids=['0','1','2','3','4','5'], pairs=ids.flatMap(a=>ids.filter(()=>random()<.3).map(b=>[a,b]));
    const out=id=>pairs.filter(([a])=>a===id).map(([,b])=>b);
    const brute=(id,seen)=>Math.max(0,...out(id).filter(n=>!seen.has(n)).map(n=>1+brute(n,new Set([...seen,n]))));
    const {metrics}=graph(ids,pairs);
    const limited=graph(ids,pairs,[],[],{stateBudget:3}).metrics;
    for(const id of ids) {
      const exact=brute(id,new Set([id]));
      assert.equal(metrics.get(id).call_depth,exact);
      assert.equal(metrics.get(id).depth_lower_bound,exact);
      assert.ok(limited.get(id).depth_lower_bound>=0 && limited.get(id).depth_lower_bound<=exact);
    }
  }
});

test('unresolved values do not invalidate the call graph, but unknown calls do', () => {
  const {metrics:m} = graph(['root','leaf','caller'], [['root','leaf']], [], [
    {function_id:'leaf', reason:'unresolved_reference'},
    {function_id:'caller', reason:'unresolved_call'},
  ]);
  assert.equal(m.get('root').call_graph_complete,1);
  assert.equal(m.get('root').call_depth,1);
  assert.equal(m.get('leaf').call_graph_complete,1);
  assert.equal(m.get('root').dependency_complete,0);
  assert.equal(m.get('root').direct_external_complete,1);
  assert.equal(m.get('leaf').direct_external_complete,0);
  assert.equal(m.get('caller').call_graph_complete,0);
});

test('expanded default budgets handle a cycle beyond the old depth and state limits', () => {
  const ids = Array.from({length:520}, (_,i)=>String(i));
  const {metrics} = graph(ids, ids.map((id,i)=>[id,ids[(i+1)%ids.length]]));
  for (const id of ids) assert.equal(metrics.get(id).call_depth,519);
});

test('explicit depth budget still stops cyclic searches without losing reachability', () => {
  const ids=['a','b','c','d'], pairs=[['a','b'],['b','c'],['c','d'],['d','a']];
  const small=graph(ids,pairs,[],[],{depthBudget:2}).metrics;
  assert.equal(small.get('a').call_depth,null);
  assert.equal(small.get('a').reachable_internal_count,4);
  assert.equal(graph(ids,pairs,[],[],{depthBudget:3}).metrics.get('a').call_depth,3);
});

test('dense cycles finish within a small state budget once longest possible paths are found', () => {
  const ids = Array.from({length:12}, (_,i)=>String(i));
  const pairs = ids.flatMap(a => ids.filter(b => b !== a).map(b => [a,b]));
  const {metrics} = graph(ids, pairs, [], [], {stateBudget:200});
  for (const id of ids) assert.equal(metrics.get(id).call_depth,11);
});

test('pruning includes downstream depth even when exits are visited last', () => {
  const ids = Array.from({length:12}, (_,i)=>String(i));
  const pairs = ids.flatMap(a => ids.filter(b => b !== a).map(b => [a,b]));
  pairs.push(...ids.map(id => [id,'tail']), ['tail','leaf']);
  const {metrics} = graph([...ids,'tail','leaf'], pairs, [], [], {stateBudget:200});
  for (const id of ids) assert.equal(metrics.get(id).call_depth,13);
});

test('a downstream depth budget failure prevents finite upper-bound pruning', () => {
  const {metrics} = graph(['a','b','c','d'], [['a','b'],['b','a'],['b','c'],['c','d'],['d','c']], [], [], {depthBudget:0});
  for (const id of ['a','b','c','d']) assert.equal(metrics.get(id).call_depth,null);
});
