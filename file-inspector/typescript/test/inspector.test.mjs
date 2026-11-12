import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../src/main.mjs';
function fixture(t, files) {
 const dir = mkdtempSync(path.join(tmpdir(), 'ts-inspector-'));
 t.after(() => rmSync(dir, {recursive:true,force:true}));
 writeFileSync(path.join(dir,'tsconfig.json'), JSON.stringify({compilerOptions:{moduleDetection:'legacy',strict:true,target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext'},include:['*.ts']}));
 for(const [name,text] of Object.entries(files)) writeFileSync(path.join(dir,name),text);
 return {dir,args:['-p',path.join(dir,'tsconfig.json'),'-o',path.join(dir,'out.sqlite')]};
}
test('graph, mutation visibility, shadowing, termination and database integrity', t => {
 const {dir,args}=fixture(t,{
 'b.ts':'export function leaf(x:number) { return x+1; }',
 'a.ts':`import {leaf} from './b.js';
export let outer=0;
export const fn=(x:number)=>leaf(x);
export function caller(p:{done:boolean},xs:number[]) {
 p.done=true; const alias=p; alias.done=true; p={done:false}; p.done=false; xs.push(1);
 leaf(1); leaf(2); leaf(3); const ref=leaf; consume(leaf); outer++;
 return ()=>{outer++;p.done=true;};
}
function consume(f:(x:number)=>number){return f(0);}
function loop(){while(false){}}
function recursive():number{return recursive();}
function shadow(outer:number){if(outer){const outer=1;return outer;}return outer;}
class Counter {value=0;bump(){this.value++;}}
`});
 const r=main(args),fn=name=>r.functions.find(f=>f.name===name);
 assert.equal(fn('leaf').termination,'terminates'); assert.equal(fn('fn').termination,'terminates');
 for(const n of ['loop','recursive','consume']) assert.equal(fn(n).termination,'unknown');
 assert.equal(fn('shadow').shadowing_count,2); assert.equal(fn('shadow').max_nesting,1);
 assert.equal(fn('shadow').cyclomatic_complexity,2);
 const ps=r.parameters.filter(p=>p.function_id===fn('caller').id);
 assert.equal(ps[0].mutation_count,2); assert.equal(ps[1].mutation_count,1);
 const accesses=r.accesses.filter(a=>a.function_id===fn('caller').id&&a.symbol_name==='outer');
 assert.equal(accesses.length,1); assert.equal(accesses[0].scope,'module'); assert.equal(accesses[0].reads,1); assert.equal(accesses[0].writes,1);
 assert.equal(r.accesses.find(a=>a.function_id===fn('Counter.bump').id&&a.mutations).scope,'class_field');
 assert.ok(r.references.some(a=>a.target_id===fn('leaf').id&&a.kind==='argument'));
 const db=new DatabaseSync(path.join(dir,'out.sqlite')); t.after(()=>db.close());
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.equal(db.prepare('SELECT call_count FROM call_counts WHERE caller_id=? AND target_id=?').get(fn('caller').id,fn('leaf').id).call_count,3);
 assert.equal(db.prepare('SELECT exported_variables FROM files WHERE id=?').get('a.ts').exported_variables,2);
});
test('line metrics preserve regex/template literals and isolate nested control flow',t=>{
 const {args}=fixture(t,{'a.ts':'// header\n\nexport function f() {\n // comment\n const r = /abc/; // mixed\n const s = `hello\n// literal`;\n const inner = () => { while(true) {} };\n return 1;\n}\n'});
 const r=main(args),file=r.files[0],f=r.functions.find(f=>f.name==='f');
 assert.equal(file.total_lines,10);assert.equal(file.blank_lines,1);assert.equal(file.comment_lines,2);assert.equal(file.lines_with_comments,3);assert.equal(file.effective_lines,7);
 assert.equal(f.max_nesting,0);assert.equal(f.termination,'terminates');
});
test('filters, overwrite and failure preservation',t=>{
 const {dir,args}=fixture(t,{'a.ts':'export function a(){}','b.ts':'export function b(){}'});
 assert.equal(main([...args,'--exclude','b.ts']).files.length,1);
 assert.equal(main([...args,'--include','b.ts']).functions[0].name,'b');
 const before=readFileSync(path.join(dir,'out.sqlite'));
 writeFileSync(path.join(dir,'b.ts'),'function broken( {');
 assert.throws(()=>main(args));assert.deepEqual(readFileSync(path.join(dir,'out.sqlite')),before);
 assert.throws(()=>main(['-p',path.join(dir,'tsconfig.json')]));
});
test('outer scopes, globals, destructuring, and method references',t=>{
 const {args}=fixture(t,{'a.ts':`let globalCount=0;
function outer(){let captured={value:0};return function inner(){captured.value++;globalCount=1;({value:captured.value}={value:2});};}
const obj={method(){return 1;}};
function refs(){const m=obj.method;return m;}
`});
 const r=main(args),inner=r.functions.find(f=>f.name==='inner'),a=r.accesses.filter(a=>a.function_id===inner.id);
 assert.equal(a.filter(a=>a.scope==='outer_function'&&a.mutations).length,2);
 assert.equal(a.find(a=>a.symbol_name==='globalCount').scope,'global');
 const method=r.functions.find(f=>f.name==='method');assert.ok(r.references.some(a=>a.target_id===method.id&&a.kind==='assignment'));
});
test('incremental cache reuses unchanged files and invalidates transitive dependents',t=>{
 const {dir,args}=fixture(t,{
  'leaf.ts':'export function leaf(){return 1;}',
  'caller.ts':"import {leaf} from './leaf.js'; export function caller(){return leaf();}",
  'other.ts':'export function other(){return 2;}',
 });
 assert.equal(main(args).files.length,3);
 const unchanged=main(args);assert.equal(unchanged.files.length,0);assert.equal(unchanged.skipped_files,3);
 writeFileSync(path.join(dir,'leaf.ts'),'export function leaf(){while(true){}}');
 const changed=main(args);assert.equal(changed.files.length,2);assert.equal(changed.skipped_files,1);
 assert.equal(changed.functions.find(f=>f.name==='caller').termination,'unknown');
 const db=new DatabaseSync(path.join(dir,'out.sqlite'));t.after(()=>db.close());
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n,3);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM functions').get().n,3);
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('parameter rebinding and alias snapshots preserve externally visible mutation semantics',t=>{
 const {args}=fixture(t,{'a.ts':`export function f(p:{x:number}) {
 const original=p;
 p={x:0};
 p.x++;
 original.x++;
}
export function g(p:{x:number},flag:boolean) {if(flag){p={x:0};}p.x++;}
`});
 const r=main(args),f=r.functions.find(f=>f.name==='f'),g=r.functions.find(f=>f.name==='g');
 assert.equal(r.parameters.find(p=>p.function_id===f.id).mutation_count,1);
 assert.equal(r.parameters.find(p=>p.function_id===g.id).possible_mutation_count,1);
});
test('partial file updates retain other results and expose parameter patterns and exported references',t=>{
 const {dir,args}=fixture(t,{
  'a.ts':'export function a({child}:{child:{x:number}}){child.x++;} export {a as again};',
  'b.ts':'export function b(){}',
 });
 main([...args,'--include','a.ts']);main([...args,'--include','b.ts']);
 const db=new DatabaseSync(path.join(dir,'out.sqlite'));t.after(()=>db.close());
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n,2);
 assert.equal(db.prepare('SELECT mutation_count FROM parameters').get().mutation_count,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM function_references WHERE kind='export'").get().n,1);
});
test('recursive project references and extended config are loaded',t=>{
 const {dir,args}=fixture(t,{'a.ts':'export function a(){}'});
 writeFileSync(path.join(dir,'base.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'CommonJS'}}));
 writeFileSync(path.join(dir,'lib.json'),JSON.stringify({extends:'./base.json',compilerOptions:{composite:true},files:['a.ts']}));
 writeFileSync(path.join(dir,'tsconfig.json'),JSON.stringify({files:[],references:[{path:'./lib.json'}]}));
 const r=main(args);assert.equal(r.files.length,1);assert.equal(r.functions[0].name,'a');
});
test('resuming an existing per-file cache recomputes termination even without source changes',t=>{
 const {dir,args}=fixture(t,{'a.ts':'export function a(){return 1;}'});
 main(args);
 const db=new DatabaseSync(path.join(dir,'out.sqlite'));
 db.exec("UPDATE functions SET termination='unknown', termination_reason=NULL");db.close();
 assert.equal(main(args).skipped_files,1);
 const reopened=new DatabaseSync(path.join(dir,'out.sqlite'));t.after(()=>reopened.close());
 assert.equal(reopened.prepare('SELECT termination FROM functions').get().termination,'terminates');
});
