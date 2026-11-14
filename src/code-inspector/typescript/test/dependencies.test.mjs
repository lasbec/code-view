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
});
test('memoized SCC depths match exhaustive simple paths on deterministic small graphs', () => {
  let seed=123;
  const random=()=> (seed=(seed*1664525+1013904223)>>>0)/2**32;
  for(let trial=0;trial<100;trial++) {
    const ids=['0','1','2','3','4','5'], pairs=ids.flatMap(a=>ids.filter(()=>random()<.3).map(b=>[a,b]));
    const out=id=>pairs.filter(([a])=>a===id).map(([,b])=>b);
    const brute=(id,seen)=>Math.max(0,...out(id).filter(n=>!seen.has(n)).map(n=>1+brute(n,new Set([...seen,n]))));
    const {metrics}=graph(ids,pairs);
    for(const id of ids) assert.equal(metrics.get(id).call_depth,brute(id,new Set([id])));
  }
});
