import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../../treemap/package.json',import.meta.url));
const {JSDOM}=require('jsdom'),{build}=require('esbuild');
import { defaultDeveloperPreset } from '../developers.mjs';
test('developer sidebar saves weights, table searches and details show raw commit counts',async t=>{
  const bundle=await build({entryPoints:[new URL('../public/developers-view.js',import.meta.url).pathname],bundle:true,format:'iife',globalName:'Developers',write:false});
  const dom=new JSDOM('<main id="host"></main>',{runScripts:'outside-only'});t.after(()=>dom.window.close());dom.window.eval(bundle.outputFiles[0].text);
  const host=dom.window.document.querySelector('#host');
  const state={selection:{},inspections:[{id:'i',name:'Repo',hasResults:true}],presets:[{id:'s',name:'Score'}],developerPresets:[{id:'d',...defaultDeveloperPreset()}]};
  const person={id:'a@example.com',name:'Alice <unsafe>',color:'hsl(20 58% 65%)',score:50,totals:{created:4,deleted:2,changed:3},perCommit:{created:4,deleted:2,changed:3},files:[{path:'a.ts',function_count:0,rawScore:50,score:50,weight:1,contribution:50}],commits:[{hash:'abc123',date:'2026-01-01',created:4,deleted:2,changed:3}]};
  person.files.push(...[0,100].map(contribution=>({path:`${contribution}.ts`,function_count:1,rawScore:contribution,score:contribution,weight:1,contribution})));
  const calls=[],api=async(path,method,value)=>{calls.push({path,method,value});if(path==='state')return state;if(path.startsWith('developers?'))return {available:true,developers:[person]};return {};};
  const settle=()=>new Promise(r=>setTimeout(r,15));
  await dom.window.Developers.mountDevelopers(host,{state,api,reload:async()=>{}});await settle();
  assert.ok(host.querySelector('.graph-sidebar form'));assert.match(host.textContent,/Alice <unsafe>/);assert.equal(host.querySelector('unsafe'),null);
  assert.equal(host.querySelector('[name="aggregation"]'),null);
  assert.equal(host.querySelector('[name="quantile"]'),null);
  const row=host.querySelector('.developer-row');
  assert.ok(row.nextElementSibling.matches('.developer-plot-row'));
  assert.equal(row.nextElementSibling.querySelector('td').colSpan,row.children.length);
  assert.match(row.nextElementSibling.querySelector('svg').getAttribute('aria-label'),/Median 50/);
  const toggle=host.querySelector('[data-plot-scale]');
  toggle.value='log1p';toggle.dispatchEvent(new dom.window.Event('change'));
  const rect=host.querySelector('svg rect');
  // Q1=25, Q3=75 and global P99=99: transform both box endpoints.
  const expectedWidth=92*(Math.log1p(75)-Math.log1p(25))/Math.log1p(99);
  assert.ok(Math.abs(parseFloat(rect.getAttribute('width'))-expectedWidth)<1e-10);
  const medianX=4+92*Math.log1p(50)/Math.log1p(99);
  assert.ok(Math.abs(parseFloat(host.querySelector('.developer-plot-median').getAttribute('x1'))-medianX)<1e-10);
  const withoutFunctions=host.querySelector('[data-plot-filter="ignoreWithoutFunctions"]');
  const zeros=host.querySelector('[data-plot-filter="ignoreZeros"]');
  const setFilter=(el,checked)=>{el.checked=checked;el.dispatchEvent(new dom.window.Event('change'));};
  assert.equal(withoutFunctions.checked,false);assert.equal(zeros.checked,false);
  const reads=calls.filter(c=>c.path.startsWith('developers?')).length;
  setFilter(withoutFunctions,true);
  assert.match(host.querySelector('svg').getAttribute('aria-label'),/2 files/);
  setFilter(zeros,true);
  assert.match(host.querySelector('svg').getAttribute('aria-label'),/1 files.*Median 100/);
  assert.equal(host.querySelectorAll('.developer-plot-overflow').length,0);
  assert.equal(host.querySelector('.developer-plot-tick:last-of-type').textContent,'100');
  setFilter(withoutFunctions,false);
  assert.match(host.querySelector('svg').getAttribute('aria-label'),/2 files.*Median 75/);
  setFilter(zeros,false);
  assert.match(host.querySelector('svg').getAttribute('aria-label'),/3 files.*Median 50/);
  assert.equal(calls.filter(c=>c.path.startsWith('developers?')).length,reads);
  host.querySelector('[data-person]').click();assert.match(host.querySelector('[data-detail]').textContent,/abc123/);
  const search=host.querySelector('[data-search]');search.value='nobody';search.dispatchEvent(new dom.window.Event('input'));assert.equal(host.querySelectorAll('tbody tr').length,0);
  host.querySelector('[name="changed"]').value='3';host.querySelector('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true,bubbles:true}));await settle();
  const saved=calls.find(c=>c.method==='PUT');assert.equal(saved.path,'developerPresets/d');assert.equal(saved.value.config.changed,3);assert.equal(saved.value.config.aggregation,'average');
});

test('boxplot excludes unowned and invalid files, retains zero, and interpolates quartiles',async()=>{
  const {contributionSummary}=await import('../public/developers-view.js');
  const files=[0,1,2,3,4,5,100].map(contribution=>({weight:.25,contribution}));
  files.push({weight:0,contribution:1000},{weight:1,contribution:null},{weight:1,contribution:NaN});
  assert.deepEqual(contributionSummary(files),{count:7,q1:1.5,median:3,q3:4.5,low:0,high:5,min:0,max:100,outliers:[100]});
  assert.equal(contributionSummary([{weight:0,contribution:0}]),null);
  assert.equal(contributionSummary([]),null);
  const extended=contributionSummary([0,1,2,3,4,5,20,100].map(contribution=>({weight:1,contribution})));
  assert.equal(extended.high,20); // Beyond 1.5 IQR, within 5 IQR.
  assert.deepEqual(extended.outliers,[100]);
  assert.deepEqual(contributionSummary([{weight:1,contribution:8}]),{count:1,q1:8,median:8,q3:8,low:8,high:8,min:8,max:8,outliers:[]});
  assert.equal(contributionSummary([8,8,8].map(contribution=>({weight:1,contribution}))).median,8);
});

test('plots sort by contribution median and keep a shared scale across search and pagination',async t=>{
  const bundle=await build({entryPoints:[new URL('../public/developers-view.js',import.meta.url).pathname],bundle:true,format:'iife',globalName:'Developers',write:false});
  const dom=new JSDOM('<main id="host"></main>',{runScripts:'outside-only'});t.after(()=>dom.window.close());dom.window.eval(bundle.outputFiles[0].text);
  const host=dom.window.document.querySelector('#host');
  const state={selection:{},inspections:[{id:'i',name:'Repo',hasResults:true}],presets:[{id:'s',name:'Score'}],developerPresets:[{id:'d',...defaultDeveloperPreset()}]};
  const people=Array.from({length:102},(_,i)=>({id:`dev${i}@example.com`,name:`Dev ${i}`,color:'blue',score:1000-i,totals:{created:0,deleted:0,changed:0},perCommit:{created:0,deleted:0,changed:0},files:[{weight:1,contribution:i}],commits:[]}));
  people.push({...people[0],id:'empty',name:'Empty',files:[]});
  const api=async()=>({available:true,developers:people});
  await dom.window.Developers.mountDevelopers(host,{state,api,reload:async()=>{}});await new Promise(r=>setTimeout(r,15));
  assert.equal(host.querySelector('[data-person]').dataset.person,'dev101@example.com');
  const ticks=()=>[...host.querySelector('svg').querySelectorAll('.developer-plot-tick')].map(t=>t.textContent);
  const scale=ticks();
  assert.equal(scale[0],'0');assert.equal(scale.at(-1),(99.99).toLocaleString());
  assert.ok(host.querySelector('.developer-plot-overflow'));
  assert.match(host.querySelector('svg').getAttribute('aria-label'),/1 files above P99.*Maximum 101/);
  host.querySelector('[data-page="1"]').click();
  assert.deepEqual(ticks(),scale);
  assert.match(host.querySelector('.developer-no-data').textContent,/No data/);
  const search=host.querySelector('[data-search]');search.value='dev50@';search.dispatchEvent(new dom.window.Event('input'));
  assert.equal(host.querySelectorAll('.developer-row').length,1);
  assert.deepEqual(ticks(),scale);
  assert.equal(host.querySelector('svg').getAttribute('tabindex'),'0');
  assert.match(host.querySelector('svg').getAttribute('aria-label'),/Median 50/);
  assert.doesNotMatch(host.querySelector('svg').outerHTML,/NaN|Infinity/);
  const linearPosition=parseFloat(host.querySelector('.developer-plot-median').getAttribute('x1'));
  const stats=host.querySelector('svg').getAttribute('aria-label');
  const toggle=host.querySelector('[data-plot-scale]');
  toggle.value='log1p';toggle.dispatchEvent(new dom.window.Event('change'));
  assert.ok(parseFloat(host.querySelector('.developer-plot-median').getAttribute('x1'))>linearPosition);
  assert.equal(host.querySelector('svg').getAttribute('aria-label'),stats);
  assert.equal(ticks().at(-1),scale.at(-1));
  assert.notEqual(ticks()[1],scale[1]);
  toggle.value='linear';toggle.dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(ticks(),scale);
  assert.equal(parseFloat(host.querySelector('.developer-plot-median').getAttribute('x1')),linearPosition);

});

test('P99 domain excludes invalid and unowned contributions and handles constant or empty data',async()=>{
  const {contributionDomain}=await import('../public/developers-view.js');
  const files=Array.from({length:999},()=>({weight:1,contribution:10}));
  files.push({weight:1,contribution:1e6},{weight:0,contribution:1e9},{weight:1,contribution:null});
  assert.deepEqual(contributionDomain([{files}]),[0,10]);
  assert.deepEqual(contributionDomain([{files:[{weight:1,contribution:0}]}]),[-1,0]);
  assert.deepEqual(contributionDomain([]),[0,1]);
  assert.deepEqual(contributionDomain([{files:[{weight:1,contribution:0},{weight:1,contribution:100}]}]),[0,99]);
});

test('plot filters combine function counts and exact zero contributions before statistics and P99',async()=>{
  const {contributionSummary,contributionDomain}=await import('../public/developers-view.js');
  const files=[{weight:1,contribution:0,function_count:1},{weight:1,contribution:10,function_count:0},{weight:.5,contribution:20,function_count:2},{weight:1,contribution:999,function_count:0}];
  const both={ignoreWithoutFunctions:true,ignoreZeros:true};
  assert.equal(contributionSummary(files,{ignoreWithoutFunctions:true}).count,2);
  assert.equal(contributionSummary(files,{ignoreWithoutFunctions:true}).median,10);
  assert.equal(contributionSummary(files,{ignoreZeros:true}).median,20);
  assert.equal(contributionSummary(files,both).count,1);
  assert.equal(contributionSummary(files,both).median,20);
  assert.deepEqual(contributionDomain([{files}],both),[0,20]);
  assert.equal(contributionSummary([files[0],files[1]],both),null);
  assert.deepEqual(contributionDomain([{files:[files[0],files[1]]}],both),[0,1]);
});
