import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { defaultPreset, validatePreset } from '../store.mjs';
const requireTreemap = createRequire(new URL('../../treemap/package.json', import.meta.url));
const { JSDOM } = requireTreemap('jsdom');
const { build } = requireTreemap('esbuild');

test('preset editor saves group and file quantiles, limits and normalization and filters the metric catalog',async t=>{
  const bundle=await build({entryPoints:[new URL('../public/app.js',import.meta.url).pathname],bundle:true,format:'esm',write:false});
  const dom=new JSDOM(await readFile(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:3210/#presets',runScripts:'outside-only'});
  t.after(()=>dom.window.close());
  const state={inspections:[],presets:[{id:'preset',...defaultPreset()}],selection:{preset:'preset'}};
  let saved;
  dom.window.fetch=async(path,options)=>{
    if(options?.method==='PUT') { saved=JSON.parse(options.body);state.presets[0]={id:'preset',...saved}; }
    return {ok:true,json:async()=>path==='/api/state'?structuredClone(state):{ok:true}};
  };
  await dom.window.eval(`(async()=>{${bundle.outputFiles[0].text}\n})()`);
  const doc=dom.window.document,change=(element,value)=>{element.value=value;element.dispatchEvent(new dom.window.Event('change',{bubbles:true}));};
  const query=name=>doc.querySelector(`[name="${name}"]`);
  const metric=query('metric');
  assert.ok([...metric.options].some(option=>option.textContent==='Cyclomatic complexity'));
  assert.ok(![...metric.options].some(option=>/diagnostics\.code|\.line$|code\.function_count/.test(option.value)));
  change(query('operation'),'quantile');query('group-quantile').value='0';
  assert.equal(doc.querySelector('#group-quantile').hidden,false);
  change(query('functionArea'),'code_parameters.count');
  query('score-max').value='80';query('normalize').checked=false;
  change(query('aggregation'),'quantile');
  assert.equal(doc.querySelector('.quantile-field').hidden,false);
  query('quantile').value='90';query('min').value='10';query('factor').value='2';
  doc.querySelector('#preset-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  for(let i=0;i<10&&!saved;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.ok(saved);validatePreset(saved);
  assert.equal(saved.config.functionArea,'code_parameters.count');
  assert.equal(saved.config.operation,'quantile');assert.equal(saved.config.quantile,0);
  assert.deepEqual(saved.config.scores[0],{name:'Complexity',normalize:false,max:80,metrics:[{metric:'code_functions.cyclomatic_complexity',aggregation:'quantile',min:10,quantile:90,factor:2}]});
  for(let i=0;i<3;i++) await new Promise(resolve=>setImmediate(resolve));
  change(query('metric'),'code_calls.count');
  assert.deepEqual([...query('aggregation').options].map(option=>option.value),['count']);
  assert.equal(doc.querySelector('.quantile-field').hidden,true);
  change(query('metric'),'code_functions.max_nesting');
  assert.equal(query('aggregation').value,'max');
});

test('function checkbox appears above the treemap, sends only transient GET options and resets on reload',async t=>{
 const bundle=await build({entryPoints:[new URL('../public/app.js',import.meta.url).pathname],bundle:true,format:'esm',write:false});
 const state={inspections:[{id:'repo',name:'Repo',hasResults:true}],presets:[{id:'preset',...defaultPreset()}],selection:{inspection:'repo',preset:'preset'}};
 const requests=[];
 async function page() {
  const dom=new JSDOM(await readFile(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:3210/#treemap',runScripts:'outside-only'});t.after(()=>dom.window.close());
  dom.window.fetch=async(path,options)=>{requests.push({path,options});return {ok:true,json:async()=>path==='/api/state'?structuredClone(state):{metrics:[],treeMapHtml:'<p>Map</p>',treeMapWarningsHtml:''}};};
  await dom.window.eval(`(async()=>{${bundle.outputFiles[0].text}\n})()`);return dom;
 }
 const first=await page(),checkbox=first.window.document.querySelector('#configuration-bar #show-functions');assert.ok(checkbox);assert.equal(checkbox.checked,false);
 checkbox.checked=true;checkbox.dispatchEvent(new first.window.Event('change',{bubbles:true}));
 for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(requests.some(r=>r.path.includes('showFunctions=true')));assert.ok(requests.every(r=>r.options.method==='GET'));
 const second=await page();assert.equal(second.window.document.querySelector('#show-functions').checked,false);
});
