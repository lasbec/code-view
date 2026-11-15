import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { defaultPreset, defaultFilter, defaultTreemap, validatePreset } from '../store.mjs';
const requireTreemap = createRequire(new URL('../../treemap/package.json', import.meta.url));
const { JSDOM } = requireTreemap('jsdom');
const { build } = requireTreemap('esbuild');

test('score editor saves named JavaScript fields with independent aggregation and no legacy controls', async t => {
  const bundle=await build({entryPoints:[new URL('../public/app.js',import.meta.url).pathname],bundle:true,format:'esm',write:false});
  const dom=new JSDOM(await readFile(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:3210/#presets',runScripts:'outside-only',pretendToBeVisual:true});
  t.after(()=>dom.window.close());
  dom.window.Range.prototype.getClientRects=()=>[];
  dom.window.Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0});
  const state={inspections:[],presets:[{id:'preset',...defaultPreset()}],filters:[{id:'filter',...defaultFilter()}],treemaps:[{id:'treemap',...defaultTreemap()}],selection:{preset:'preset'}};
  let saved;
  dom.window.fetch=async(path,options)=>{
    if(path==='/api/score/editor') return {ok:true,json:async()=>({diagnostics:[],name:'Cyclomatic complexity',metrics:[],tools:['sum','max']})};
    if(options?.method==='PUT') { saved=JSON.parse(options.body);state.presets[0]={id:'preset',...saved}; }
    return {ok:true,json:async()=>path==='/api/state'?structuredClone(state):{ok:true}};
  };
  await dom.window.eval(`(async()=>{${bundle.outputFiles[0].text}\n})()`);
  const doc=dom.window.document;
  assert.match(doc.body.textContent,/Score configuration/);
  assert.equal(doc.querySelector('[name="heat-max"]'),null);
  assert.equal(doc.querySelector('[name="include"]'),null);
  assert.equal(doc.querySelector('[name="normalize"]'),null);
  assert.ok(doc.querySelector('.cm-editor'));
  const field=doc.querySelector('.formula-field');
  field.querySelector('[name="code"]').value='const x = metrics.cyclomatic_complexity; return x * 2;';
  field.querySelector('[name="aggregation"]').value='max(scores) ?? 0';
  const name=field.querySelector('[name="field-name"]'); name.value='Risk';name.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  for(let i=0;i<4;i++) doc.querySelector('[data-action="add-file-field"]').click();
  assert.equal(doc.querySelectorAll('.formula-field').length,5,'No legacy three-group limit');
  doc.querySelector('#preset-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  for(let i=0;i<20&&!saved;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.ok(saved);validatePreset(saved);
  assert.equal(saved.config.fields[0].name,'Risk');
  assert.equal(saved.config.fields[0].autoName,false);
  assert.equal(saved.config.fields[0].aggregation,'max(scores) ?? 0');
  assert.match(saved.config.fields[0].code,/const x/);
  assert.deepEqual(Object.keys(saved.config),['fields']);
});

test('view preferences persist locally and data reload retains them',async t=>{
 const bundle=await build({entryPoints:[new URL('../public/app.js',import.meta.url).pathname],bundle:true,format:'esm',write:false});
 const state={inspections:[{id:'repo',name:'Repo',hasResults:true}],presets:[{id:'preset',...defaultPreset()}],filters:[{id:'filter',...defaultFilter()}],treemaps:[{id:'treemap',...defaultTreemap()}],selection:{inspection:'repo',preset:'preset'}};
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
 const state={inspections:[{id:'repo',name:'Repo',hasResults:true}],presets:[{id:'preset',...defaultPreset()}],filters:[{id:'filter',...defaultFilter()}],treemaps:[{id:'treemap',...defaultTreemap()}],selection:{inspection:'repo',preset:'preset'}};
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
 assert.deepEqual(JSON.parse(dom.window.localStorage.getItem('code-view.settings.v1')).heat[JSON.stringify(['repo','preset','filter','treemap'])],heat);
 assert.ok(replies.some(r=>r.type==='code-view-heat-result'&&!r.error));
 await poll();assert.equal(dom.window.document.querySelector('#map iframe'),frame);
 dom.window.dispatchEvent(new dom.window.MessageEvent('message',{source:frame.contentWindow,data:{type:'code-view-heat',heat:{max:'bad'}}}));
 for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(replies.some(r=>r.type==='code-view-heat-result'&&r.error==='Invalid heat thresholds.'));
 dom.window.document.querySelector('#reload-data').click();
 for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
 const freshFrame=dom.window.document.querySelector('#map iframe');assert.notEqual(freshFrame,frame);
 const restored=[];freshFrame.contentWindow.postMessage=message=>restored.push(message);
 freshFrame.dispatchEvent(new dom.window.Event('load'));
 assert.deepEqual(JSON.parse(JSON.stringify(restored.find(m=>m.type==='code-view-options').heat)),heat);
 assert.equal(saved,undefined);
 dom.window.location.hash='#treemap-settings';
 await new Promise(resolve=>dom.window.setTimeout(resolve,0));
 assert.equal(dom.window.document.querySelector('[name="heat-yellowFrom"]').value,'');
});

test('treemap sandbox permits the heat form to submit', async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const sandbox=source.match(/setAttribute\('sandbox', '([^']+)'\)/)[1].split(' ');
  assert.ok(sandbox.includes('allow-forms'));
});
