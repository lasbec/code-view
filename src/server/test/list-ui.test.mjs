import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { selectRows } from '../public/list-view.js';
const require = createRequire(new URL('../../treemap/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const { build } = require('esbuild');
const rows = [
  { id:'a', name:'load', path:'a.ts', line:1, kind:'MethodDeclaration', visibility:'private', is_async:0, signature:'(): void', score:0 },
  { id:'b', name:'fetch', path:'b.ts', line:2, kind:'ArrowFunction', visibility:'public', is_async:1, signature:'(): Promise<string>', score:10 },
  { id:'c', name:'other', path:'c.ts', line:3, kind:'FunctionDeclaration', visibility:'not_applicable', is_async:0, signature:'(): string', score:null },
];
const defaults = { search:'', signature:'', filters:[], sort:'score', direction:-1 };
test('searches intersect with one OR multiselect and null scores sort last in either direction', () => {
  assert.deepEqual(selectRows(rows,{...defaults,filters:['visibility:private','is_async']}).map(r=>r.id),['b','a']);
  assert.deepEqual(selectRows(rows,{...defaults,filters:['visibility:private','is_async'],signature:'VOID',search:'A.TS'}).map(r=>r.id),['a']);
  assert.deepEqual(selectRows(rows,{...defaults,direction:1}).map(r=>r.id),['a','b','c']);
  assert.deepEqual(selectRows(rows,defaults).map(r=>r.id),['b','a','c']);
  assert.deepEqual(rows.map(r=>r.score),[0,10,null]);
});
test('list UI keeps searches independent, supports OR chips, sorting, pagination and detail links without refetching', async t => {
  const bundle=await build({entryPoints:[new URL('../public/list-view.js',import.meta.url).pathname],bundle:true,format:'iife',globalName:'Lists',write:false});
  const dom=new JSDOM('<main><section id="list"></section></main>',{url:'http://localhost/#functions',runScripts:'outside-only'});
  t.after(()=>dom.window.close());dom.window.scrollTo=()=>{};
  dom.window.eval(bundle.outputFiles[0].text);
  const doc=dom.window.document,host=doc.querySelector('#list');let calls=0,opened;
  const all=[...rows,...Array.from({length:101},(_,i)=>({...rows[2],id:`z${i}`,name:`extra${i}`}))];
  const options={kind:'function',inspection:{id:'i'},preset:{id:'p'},api:async()=>{calls++;return {files:[],functions:all,traitsAvailable:true};},openDetail:href=>{opened=href;}};
  await dom.window.Lists.mountInspectionList(host,options);
  assert.match(host.querySelector('[data-page-count]').textContent,/1 of 2/);
  host.querySelector('[data-page="1"]').click();assert.match(host.querySelector('[data-page-count]').textContent,/2 of 2/);
  const search=host.querySelector('[data-list-search]');search.value='load';search.dispatchEvent(new dom.window.Event('input'));
  assert.match(host.querySelector('[data-result-count]').textContent,/1 \/ 104/);
  const signature=host.querySelector('[data-list-signature]');signature.value='Promise';signature.dispatchEvent(new dom.window.Event('input'));
  assert.match(host.textContent,/No matching items/);
  search.value='';search.dispatchEvent(new dom.window.Event('input'));signature.value='';signature.dispatchEvent(new dom.window.Event('input'));
  for(const value of ['visibility:private','is_async']) {const box=host.querySelector(`input[value="${value}"]`);box.checked=true;box.dispatchEvent(new dom.window.Event('change',{bubbles:true}));}
  assert.match(host.querySelector('[data-result-count]').textContent,/2 \/ 104/);
  assert.equal(host.querySelectorAll('[data-remove-filter]').length,2);
  host.querySelector('[data-sort="score"]').click();assert.equal(host.querySelector('tbody tr').dataset.item,'a');
  host.querySelector('tbody a').click();assert.match(opened,/kind=function/);assert.match(opened,/listContext=true/);assert.match(opened,/from=functions/);
  const replacement=doc.createElement('section');host.replaceWith(replacement);
  await dom.window.Lists.mountInspectionList(replacement,options);
  assert.equal(replacement.querySelectorAll('[data-remove-filter]').length,2);assert.equal(calls,1);
  replacement.querySelector('[data-clear-filters]').click();assert.match(replacement.querySelector('[data-result-count]').textContent,/104 \/ 104/);
});
