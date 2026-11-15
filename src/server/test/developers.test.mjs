import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateDeveloper, developerData, defaultDeveloperPreset, validateDeveloperPreset } from '../developers.mjs';

test('weighted aggregation preserves shares rather than averaging attributed amounts',()=>{
  const config=defaultDeveloperPreset().config, values=[{score:100,weight:.1},{score:20,weight:.9}];
  assert.equal(aggregateDeveloper(values,config),28);
  assert.equal(aggregateDeveloper(values,{...config,aggregation:'sum'}),28);
  assert.equal(aggregateDeveloper(values,{...config,aggregation:'median'}),20);
  assert.equal(aggregateDeveloper(values,{...config,aggregation:'quantile',quantile:95}),17.6);
  assert.equal(aggregateDeveloper([{score:null,weight:1}],config),null);
  assert.throws(()=>validateDeveloperPreset({name:'bad',config:{...config,changed:-1}}));
});
test('quantiles interpolate score contributions with equal weight per attributed file',()=>{
  const config={...defaultDeveloperPreset().config,aggregation:'quantile'};
  const values=[{score:100,weight:.1},{score:20,weight:.9},{score:0,weight:1},{score:999,weight:0},{score:null,weight:1}];
  for (const [quantile,expected] of [[0,0],[25,5],[50,10],[75,14],[100,18]]) {
    assert.equal(aggregateDeveloper(values,{...config,quantile}),expected);
  }
  assert.equal(aggregateDeveloper([{score:100,weight:.1}],config),10);
  assert.equal(aggregateDeveloper([{score:null,weight:1},{score:20,weight:0}],config),null);
});
test('attribution merges aliases, counts unique commits, keeps raw activity separate and honors scope',t=>{
  const dir=mkdtempSync(join(tmpdir(),'developers-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'test.sqlite'),db=new DatabaseSync(path);
  db.exec(`CREATE TABLE git_commits(repository_id,hash,author_name,author_email,committed_at,is_merge);
  CREATE TABLE git_file_changes(repository_id,commit_hash,path,lines_created,lines_removed,lines_changed);
  INSERT INTO git_commits VALUES(1,'a','Alice','alias@example.com','2026-01-01',0),(1,'b','Bob','bob@example.com','2026-01-02',0),(1,'m','Merge','merge@example.com','2026-01-03',1);
  INSERT INTO git_file_changes VALUES(1,'a','a.ts',3,0,1),(1,'a','b.ts',2,0,0),(1,'a','ignored.ts',100,0,0),(1,'b','a.ts',1,0,1),(1,'m','a.ts',99,0,0);`);db.close();
  const files=[{path:'a.ts',score:100,effective_lines:10,function_count:2},{path:'b.ts',score:20,effective_lines:0,function_count:0}], preset=defaultDeveloperPreset();
  const identities=[{name:'Canonical Alice',email:'alice@example.com',aliases:['alias@example.com']}];
  const result=developerData(path,files,preset,identities);
  assert.equal(result.developers.length,2);
  const alice=result.developers.find(p=>p.id==='alice@example.com');
  assert.equal(alice.name,'Canonical Alice');assert.equal(alice.commits.length,1);assert.equal(alice.totals.created,5);assert.equal(alice.totals.changed,1);
  assert.equal(alice.files[0].function_count,2);assert.equal(alice.files[1].function_count,0);
  assert.equal(alice.files[0].weight,2/3);assert.equal(result.mainAuthors['a.ts'].id,alice.id);
  assert.equal(result.authorship['a.ts'].authors[0].share,2/3);
  assert.equal(result.authorship['a.ts'].basis,'churn');
  const contributions=developerData(path,files,{...preset,config:{...preset.config,aggregation:'quantile',quantile:50}},identities);
  const contributionAlice=contributions.developers.find(p=>p.id===alice.id);
  assert.equal(contributionAlice.score,contributionAlice.files.reduce((sum,f)=>sum+f.contribution,0)/2);
  const winner=developerData(path,files,{...preset,config:{...preset.config,attribution:'winner'}},identities);
  assert.equal(winner.developers.find(p=>p.id==='bob@example.com').score,null);
  const normalized=developerData(path,files,{...preset,config:{...preset.config,normalization:'lines'}},identities);
  assert.equal(normalized.developers.find(p=>p.id===alice.id).score,10);
  const quantile=developerData(path,files,{...preset,config:{...preset.config,aggregation:'quantile',quantile:50,normalization:'lines'}},identities);
  const quantileAlice=quantile.developers.find(p=>p.id===alice.id);
  assert.equal(quantileAlice.score,quantileAlice.files[0].contribution);
  assert.equal(quantileAlice.score,10*(2/3));
  assert.equal(developerData(path,files,preset,identities,{since:'2026-01-02'}).developers.length,1);
  assert.equal(developerData(path,files,{...preset,config:{...preset.config,merges:'only'}},identities).developers[0].name,'Merge');
});

test('size weighting and strict authorship thresholds preserve activity and optionally renormalize survivors',t=>{
  const dir=mkdtempSync(join(tmpdir(),'developer-threshold-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'test.sqlite'),db=new DatabaseSync(path);
  db.exec(`CREATE TABLE git_commits(repository_id,hash,author_name,author_email,committed_at,is_merge);
    CREATE TABLE git_file_changes(repository_id,commit_hash,path,lines_created,lines_removed,lines_changed);
    INSERT INTO git_commits VALUES(1,'a','A','a','2026-01-01',0),(1,'b','B','b','2026-01-02',0),(1,'c','C','c','2026-01-03',0);
    INSERT INTO git_file_changes VALUES(1,'a','a.ts',80,0,0),(1,'b','a.ts',15,0,0),(1,'c','a.ts',5,0,0);`);db.close();
  const files=[{path:'a.ts',score:10,size_bytes:100,total_lines:20,effective_lines:5}];
  const run=(config={},options={})=>developerData(path,files,{name:'Test',config:{...defaultDeveloperPreset().config,...config}},[],options);
  const author=(result,id)=>result.developers.find(p=>p.id===id);
  assert.equal(defaultDeveloperPreset().config.authorshipThreshold,2);
  for(const [sizeWeighting,factor] of [['none',1],['size_bytes',100],['total_lines',20],['effective_lines',5]]) {
    const a=author(run({sizeWeighting,authorshipThreshold:5}),'a');
    assert.equal(a.files[0].contribution,8*factor);assert.equal(a.score,10*factor);
  }
  const filtered=run({authorshipThreshold:5});
  assert.equal(author(filtered,'c').files.length,0);
  assert.equal(author(filtered,'c').commits.length,1);assert.equal(author(filtered,'c').totals.created,5);
  assert.equal(author(filtered,'a').files[0].weight,.8);
  const scaled=run({authorshipThreshold:5,renormalizeAuthorship:true});
  assert.equal(author(scaled,'a').files[0].weight,80/95);
  assert.equal(author(scaled,'b').files[0].weight,15/95);
  for(const config of [{authorshipThreshold:100,renormalizeAuthorship:true},{authorshipThreshold:80,attribution:'winner'}]) {
    assert.ok(run(config).developers.every(p=>p.files.length===0 && p.score===null));
  }
  assert.equal(author(run({attribution:'winner'}),'a').files[0].weight,1);
  assert.equal(author(run({authorshipThreshold:100},{applyAuthorshipThreshold:false}),'c').files.length,1);
  // Shared treemap/detail authorship stays unfiltered.
  assert.equal(filtered.authorship['a.ts'].authors.length,3);
  for(const size of [0,undefined]) {
    files[0].size_bytes=size;
    const a=author(run({sizeWeighting:'size_bytes'}),'a');
    assert.equal(a.files[0].contribution,size===0?0:null);assert.equal(a.score,size===0?0:null);
  }
  files[0].effective_lines=0;
  assert.equal(author(run({normalization:'lines',sizeWeighting:'effective_lines'}),'a').score,null);
  for(const config of [{authorshipThreshold:-1},{authorshipThreshold:101},{authorshipThreshold:NaN},{renormalizeAuthorship:1},{sizeWeighting:'bad'}]) {
    assert.throws(()=>validateDeveloperPreset({name:'Bad',config:{...defaultDeveloperPreset().config,...config}}));
  }
  const legacy=defaultDeveloperPreset();delete legacy.config.sizeWeighting;delete legacy.config.authorshipThreshold;delete legacy.config.renormalizeAuthorship;
  assert.equal(validateDeveloperPreset(legacy).config.authorshipThreshold,2);
});
