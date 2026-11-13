import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stronglyConnected, communities, groupGraph, readGraph } from '../graph.mjs';
import { defaultGraphPreset, validateGraphPreset } from '../graph-config.mjs';
import { createApp } from '../server.mjs';
const edge=(source,target,weight=1)=>({source,target,weight});
test('SCC groups overlapping cycles, retains bridges and handles long chains iteratively',()=>{
  assert.deepEqual(stronglyConnected(['a','b','c','d'],[edge('a','b'),edge('b','a'),edge('b','c'),edge('c','b'),edge('c','d')]).map(g=>g.join()).sort(),['a,b,c','d']);
  const ids=Array.from({length:15000},(_,i)=>String(i));
  assert.equal(stronglyConnected(ids,ids.slice(1).map((id,i)=>edge(String(i),id))).length,15000);
  const c={...defaultGraphPreset().config,mode:'cycles'};
  const grouped=groupGraph(['a','b','c'].map(id=>({id})),[edge('a','b'),edge('b','a'),edge('c','c')],c);
  assert.equal(grouped.cycleCount,2);
  assert.equal(grouped.groups.find(g=>g.children)?.members.length,2);
  assert.equal(groupGraph([{id:'c'}],[edge('c','c')],{...c,selfLoops:false}).cycleCount,0);
});
test('modularity separates dense neighborhoods, responds to resolution, and stays reproducible',()=>{
  const ids=['a','b','c','d','e','f'], edges=[];
  for(const group of [ids.slice(0,3),ids.slice(3)])for(const a of group)for(const b of group)if(a!==b)edges.push(edge(a,b,5));
  edges.push(edge('c','d',.1));
  const result=communities(ids,edges);
  assert.deepEqual(result.map(g=>g.join()).sort(),['a,b,c','d,e,f']);
  assert.deepEqual(communities(ids,edges),result);
  assert.ok(communities(ids,edges,5).length>result.length);
  assert.equal(communities(['a','b'],[edge('a','b')],1,true).length,2);
});
export async function fixture(path){
  const db=new DatabaseSync(path);
  db.exec(`CREATE TABLE code_files(id TEXT); CREATE TABLE code_functions(id TEXT,name TEXT,file_id TEXT,line INTEGER);
    CREATE TABLE code_calls(caller_id TEXT,file_id TEXT,target_id TEXT,resolution TEXT,kind TEXT,line INTEGER,target_name TEXT);
    CREATE TABLE code_imports(file_id TEXT,target_file_id TEXT,kind TEXT,line INTEGER,specifier TEXT);
    INSERT INTO code_files VALUES('a.ts'),('b.ts'),('c.ts');
    INSERT INTO code_functions VALUES('af','alpha','a.ts',1),('bf','beta','b.ts',1),('cf','charlie','c.ts',1);
    INSERT INTO code_calls VALUES('af','a.ts','bf','resolved','call',2,'beta'),('af','a.ts','bf','resolved','call',3,'beta'),('bf','b.ts','af','resolved','call',4,'alpha'),('cf','c.ts',NULL,'unknown','call',3,'dynamic');
    INSERT INTO code_imports VALUES('a.ts','b.ts','import',1,'./b');`);
  db.close();
}
test('SQLite extraction bundles evidence, preserves weights, filters before grouping and reports uncertainty',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'graph-fixture-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'analysis.sqlite');await fixture(path);
  const c=defaultGraphPreset().config,result=readGraph(path,{...c,mode:'cycles',weighting:'log'});
  assert.equal(result.edges.length,2);assert.equal(result.edges[0].count,2);assert.equal(result.edges[0].weight,Math.log(3));assert.equal(result.edges[0].evidence[1].line,3);assert.equal(result.cycleCount,1);
  assert.ok(result.warnings.some(w=>w.includes('1 unresolved')));
  assert.equal(readGraph(path,{...c,exclude:['b.ts']}).cycleCount,0);
  assert.deepEqual(readGraph(path,{...c,level:'function'}).nodes.map(n=>n.id),['af','bf','cf']);
  assert.equal(readGraph(path,{...c,relation:'imports'}).edges.length,1);
});
test('graph presets validate, support CRUD and selection, and survive restart',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'graph-api-')),app=await createApp({directory:dir});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const call=async(path,method='GET',value)=>{const r=await fetch(`http://127.0.0.1:${app.server.address().port}/api/${path}`,{method,...(value?{headers:{'content-type':'application/json'},body:JSON.stringify(value)}:{})});return {status:r.status,value:await r.json()};};
  const saved=await call('graphPresets','POST',{...defaultGraphPreset(),name:'Cycles',config:{...defaultGraphPreset().config,mode:'cycles',level:'function',include:['src/**']}});
  assert.equal(saved.status,200);assert.equal((await call('state')).value.selection.graphPreset,saved.value.id);
  const {openStore}=await import('../store.mjs');assert.equal((await openStore(dir)).get().graphPresets.find(p=>p.id===saved.value.id).config.mode,'cycles');
  assert.equal((await call(`graphPresets/${saved.value.id}`,'PUT',{...saved.value,name:'Updated'})).status,200);
  assert.equal((await call('selection','POST',{graphPreset:'missing'})).status,400);
  assert.equal((await call('graphPresets','POST',{name:'Bad',config:{resolution:0}})).status,400);
  assert.equal((await call('graph?inspection=missing&preset=missing')).status,400);
  assert.equal((await call(`graphPresets/${saved.value.id}`,'DELETE')).status,200);
  assert.ok((await call('state')).value.selection.graphPreset);
  assert.throws(()=>validateGraphPreset({name:'Bad',config:{level:'function',relation:'imports'}}));
});
