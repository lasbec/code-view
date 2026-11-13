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

test('view preferences persist locally and data reload retains them',async t=>{
 const bundle=await build({entryPoints:[new URL('../public/app.js',import.meta.url).pathname],bundle:true,format:'esm',write:false});
 const state={inspections:[{id:'repo',name:'Repo',hasResults:true}],presets:[{id:'preset',...defaultPreset()}],selection:{inspection:'repo',preset:'preset'}};
 const requests=[];
 async function page(preferences) {
  const dom=new JSDOM(await readFile(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:3210/#treemap',runScripts:'outside-only'});t.after(()=>dom.window.close());
  if(preferences) dom.window.localStorage.setItem('code-view.settings.v1',preferences);
  dom.window.fetch=async(path,options)=>{requests.push({path,options});return {ok:true,json:async()=>path==='/api/state'?structuredClone(state):{metrics:[],treeMapHtml:'<p>Map</p>',treeMapWarningsHtml:''}};};
  await dom.window.eval(`(async()=>{${bundle.outputFiles[0].text}\n})()`);return dom;
 }
 const first=await page(),checkbox=first.window.document.querySelector('#configuration-bar #show-functions');assert.ok(checkbox);assert.equal(checkbox.checked,false);
 for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
 const doc=first.window.document, directories=doc.querySelector('#show-directories');
 assert.equal(directories.parentElement.previousElementSibling,checkbox.parentElement);
 assert.match(directories.parentElement.textContent,/Show directories/);
 const messages=[],frame=doc.querySelector('#map iframe');frame.contentWindow.postMessage=message=>messages.push(message);
 directories.click();assert.ok(messages.some(m=>m.type==='code-view-options'&&m.showDirectories===false));
 const configuration=doc.querySelector('[data-select="preset"]');
 assert.equal(configuration.querySelector('optgroup option').textContent,'Color by author');
 configuration.value='__author__';configuration.dispatchEvent(new first.window.Event('change',{bubbles:true}));
 assert.ok(messages.some(m=>m.type==='code-view-options'&&m.colorByAuthor===true));

 checkbox.checked=true;checkbox.dispatchEvent(new first.window.Event('change',{bubbles:true}));
 for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(requests.some(r=>r.path.includes('showFunctions=true')));assert.ok(requests.every(r=>r.options.method==='GET'));
 const stored=first.window.localStorage.getItem('code-view.settings.v1');
 const second=await page(stored);assert.equal(second.window.document.querySelector('#show-functions').checked,true);
 assert.equal(second.window.document.querySelector('#show-directories').checked,false);
 assert.equal(second.window.document.querySelector('[data-select="preset"]').value,'__author__');
 for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
 const count=()=>requests.filter(r=>r.path.startsWith('/api/treemap?')).length;
 const before=count();
 first.window.location.hash='#help';await new Promise(r=>setImmediate(r));
 first.window.location.hash='#treemap';for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));
 assert.equal(count(),before,'returning to treemap uses cached data');
 first.window.document.querySelector('#reload-data').click();
 for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
 assert.equal(count(),before+1,'Reload refetches data');
 assert.equal(first.window.localStorage.getItem('code-view.settings.v1'),stored);
 assert.equal(first.window.document.querySelector('#show-directories').checked,false);

});

test('treemap heat messages save locally per preset, retain the iframe and reject invalid values',async t=>{
 const bundle=await build({entryPoints:[new URL('../public/app.js',import.meta.url).pathname],bundle:true,format:'esm',write:false});
 const state={inspections:[{id:'repo',name:'Repo',hasResults:true}],presets:[{id:'preset',...defaultPreset()}],selection:{inspection:'repo',preset:'preset'}};
 const original=structuredClone(state.presets[0]);
 const dom=new JSDOM(await readFile(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:3210/#treemap',runScripts:'outside-only'});
 t.after(()=>dom.window.close());
 let saved,poll;const replies=[];
 dom.window.setInterval=callback=>{poll=callback;};
 dom.window.fetch=async(path,options)=>{
  if(options.method==='PUT') {
   saved=JSON.parse(options.body);state.presets[0]={id:'preset',...saved};
   return {ok:true,json:async()=>structuredClone(state.presets[0])};
  }
  return {ok:true,json:async()=>path==='/api/state'?structuredClone(state):{metrics:[],treeMapHtml:'<p>Map</p>',treeMapWarningsHtml:''}};
 };
 await dom.window.eval(`(async()=>{${bundle.outputFiles[0].text}\n})()`);
 for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
 const frame=dom.window.document.querySelector('#map iframe');assert.ok(frame);
 frame.contentWindow.postMessage=message=>replies.push(message);
 dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:frame.contentWindow,data:{type:'code-view-path',path:'src/lib'}}));
 assert.equal(new URLSearchParams(dom.window.location.search).get('treemapPath'),'src/lib');
 frame.dispatchEvent(new dom.window.Event('load'));
 assert.ok(replies.some(r=>r.type==='code-view-set-path'&&r.path==='src/lib'));
 assert.equal(dom.window.document.querySelector('#map iframe'),frame);
 const heat={min:0,yellowFrom:20,redFrom:50,max:100};
 const send=source=>dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source,data:{type:'code-view-heat',heat}}));
 send(dom.window);assert.equal(saved,undefined);
 send(frame.contentWindow);
 for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(saved,undefined);assert.deepEqual(state.presets[0],original);
 assert.deepEqual(JSON.parse(dom.window.localStorage.getItem('code-view.settings.v1')).heat[JSON.stringify(['repo','preset'])],heat);
 assert.ok(replies.some(r=>r.type==='code-view-heat-result'&&!r.error));
 await poll();assert.equal(dom.window.document.querySelector('#map iframe'),frame);
 dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:frame.contentWindow,data:{type:'code-view-heat',heat:{max:-1}}}));
 for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(replies.some(r=>r.type==='code-view-heat-result'&&r.error==='Invalid heat thresholds.'));
 dom.window.document.querySelector('#reload-data').click();
 for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
 const freshFrame=dom.window.document.querySelector('#map iframe');assert.notEqual(freshFrame,frame);
 const restored=[];freshFrame.contentWindow.postMessage=message=>restored.push(message);
 freshFrame.dispatchEvent(new dom.window.Event('load'));
 assert.deepEqual(JSON.parse(JSON.stringify(restored.find(m=>m.type==='code-view-options').heat)),heat);
 assert.equal(saved,undefined);
 dom.window.location.hash='#presets';
 await new Promise(resolve=>dom.window.setTimeout(resolve,0));
 assert.equal(dom.window.document.querySelector('[name="heat-yellowFrom"]').value,'');
});

test('treemap sandbox permits the heat form to submit', async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const sandbox=source.match(/setAttribute\('sandbox', '([^']+)'\)/)[1].split(' ');
  assert.ok(sandbox.includes('allow-forms'));
});
