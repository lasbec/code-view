import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../src/main.mjs';
import { loadProject } from '../src/project.mjs';
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
 assert.equal(db.prepare('SELECT call_count FROM code_call_counts WHERE caller_id=? AND target_id=?').get(fn('caller').id,fn('leaf').id).call_count,3);
 assert.equal(db.prepare('SELECT exported_variables FROM code_files WHERE id=?').get('a.ts').exported_variables,2);
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
test('every run rebuilds unchanged files and recalculates dependent termination',t=>{
 const {dir,args}=fixture(t,{
  'leaf.ts':'export function leaf(){return 1;}',
  'caller.ts':"import {leaf} from './leaf.js'; export function caller(){return leaf();}",
  'other.ts':'export function other(){return 2;}',
 });
 assert.equal(main(args).files.length,3);
 const unchanged=main(args);assert.equal(unchanged.files.length,3);assert.equal(unchanged.skipped_files,0);
 writeFileSync(path.join(dir,'leaf.ts'),'export function leaf(){while(true){}}');
 const changed=main(args);assert.equal(changed.files.length,3);assert.equal(changed.skipped_files,0);
 assert.equal(changed.functions.find(f=>f.name==='caller').termination,'unknown');
 const db=new DatabaseSync(path.join(dir,'out.sqlite'));t.after(()=>db.close());
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_files').get().n,3);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_functions').get().n,3);
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
test('filtered rebuilds replace previous selections and expose parameter patterns and exported references',t=>{
 const {dir,args}=fixture(t,{
  'a.ts':'export function a({child}:{child:{x:number}}){child.x++;} export {a as again};',
  'b.ts':'export function b(){}',
 });
 main([...args,'--include','b.ts']);main([...args,'--include','a.ts']);
 const db=new DatabaseSync(path.join(dir,'out.sqlite'));t.after(()=>db.close());
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_files').get().n,1);
 assert.equal(db.prepare('SELECT mutation_count FROM code_parameters').get().mutation_count,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM code_function_references WHERE kind='export'").get().n,1);
});
test('recursive project references and extended config are loaded',t=>{
 const {dir,args}=fixture(t,{'a.ts':'export function a(){}'});
 writeFileSync(path.join(dir,'base.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'CommonJS'}}));
 writeFileSync(path.join(dir,'lib.json'),JSON.stringify({extends:'./base.json',compilerOptions:{composite:true},files:['a.ts']}));
 writeFileSync(path.join(dir,'tsconfig.json'),JSON.stringify({files:[],references:[{path:'./lib.json'}]}));
 const r=main(args);assert.equal(r.files.length,1);assert.equal(r.functions[0].name,'a');
});
test('empty referenced configs warn while application files are analyzed',t=>{
 const {dir,args}=fixture(t,{'a.ts':'export function a(){}','.eslintrc.js':'module.exports = {};'});
 writeFileSync(path.join(dir,'tsconfig.node.json'),JSON.stringify({compilerOptions:{composite:true},include:['vite.config.js','.eslintrc.js']}));
 writeFileSync(path.join(dir,'tsconfig.json'),JSON.stringify({include:['a.ts'],references:[{path:'./tsconfig.node.json'}]}));
 const warnings=[];t.mock.method(console,'error',message=>warnings.push(message));
 const r=main(args);
 assert.deepEqual(r.files.map(f=>f.id),['a.ts']);
 assert.ok(r.functions.some(f=>f.name==='a'));
 assert.ok(r.diagnostics.some(d=>d.code===18003&&d.file==='tsconfig.node.json'));
 assert.ok(warnings.some(w=>/Warning.*tsconfig.node.json.*No inputs/.test(w)));
 const db=new DatabaseSync(path.join(dir,'out.sqlite'));t.after(()=>db.close());
 assert.equal(db.prepare('SELECT file FROM code_diagnostics WHERE code=18003').get().file,'tsconfig.node.json');
});
test('empty root configs and other referenced config errors still fail',t=>{
 const {dir}=fixture(t,{}),config=path.join(dir,'tsconfig.json');
 assert.throws(()=>loadProject(config),/TS18003/);
 writeFileSync(path.join(dir,'a.ts'),'export function a(){}');
 writeFileSync(config,JSON.stringify({include:['a.ts'],references:[{path:'./bad.json'}]}));
 writeFileSync(path.join(dir,'bad.json'),JSON.stringify({compilerOptions:{unknownOption:true},include:['missing.ts']}));
 assert.throws(()=>loadProject(config),/unknownOption/);
});
test('rebuilding replaces stored results even without source changes',t=>{
 const {dir,args}=fixture(t,{'a.ts':'export function a(){return 1;}'});
 main(args);
 const db=new DatabaseSync(path.join(dir,'out.sqlite'));
 db.exec("UPDATE code_functions SET termination='unknown', termination_reason=NULL");db.close();
 assert.equal(main(args).skipped_files,0);
 const reopened=new DatabaseSync(path.join(dir,'out.sqlite'));t.after(()=>reopened.close());
 assert.equal(reopened.prepare('SELECT termination FROM code_functions').get().termination,'terminates');
});

test('shared databases retain legacy and unrelated objects and accept another project',t=>{
 const first=fixture(t,{'a.ts':'export function a(){}'});
 const second=fixture(t,{'b.ts':'export function b(){}'});
 const output=path.join(first.dir,'out.sqlite');
 const db=new DatabaseSync(output);
 db.exec("CREATE TABLE files (value TEXT); INSERT INTO files VALUES ('legacy'); CREATE INDEX legacy_index ON files(value); CREATE VIEW legacy_view AS SELECT value FROM files; CREATE TABLE code_custom (value TEXT); INSERT INTO code_custom VALUES ('custom');");
 db.close();
 main(first.args);
 main(['-p',path.join(second.dir,'tsconfig.json'),'-o',output]);
 const reopened=new DatabaseSync(output);t.after(()=>reopened.close());
 assert.equal(reopened.prepare('SELECT value FROM legacy_view').get().value,'legacy');
 assert.equal(reopened.prepare('SELECT value FROM code_custom').get().value,'custom');
 assert.equal(reopened.prepare('SELECT name FROM code_functions').get().name,'b');
 assert.equal(reopened.prepare("SELECT value FROM code_metadata WHERE key='tsconfig'").get().value,path.join(second.dir,'tsconfig.json'));
 const objects=reopened.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('files','legacy_index','legacy_view','code_custom')").all();
 assert.equal(objects.filter(o=>o.type==='table').length,16);
 assert.equal(objects.filter(o=>o.type==='view').length,3);
 assert.equal(objects.filter(o=>o.type==='index').length,5);
 assert.ok(objects.every(o=>o.name.startsWith('code_')));
 assert.equal(reopened.prepare('SELECT function_count FROM code_file_function_counts').get().function_count,1);
 assert.deepEqual(reopened.prepare('SELECT * FROM code_access_counts').all(),[]);
});
test('failed rebuild rolls back schema and rows without cascading into foreign tables',t=>{
 const {dir,args}=fixture(t,{'a.ts':'export function a(){}','b.ts':'export function b(){}'});
 main(args);
 const output=path.join(dir,'out.sqlite');
 const db=new DatabaseSync(output);
 db.exec("PRAGMA foreign_keys=ON; CREATE TABLE bookmarks (file_id TEXT REFERENCES code_files(id) ON DELETE CASCADE); INSERT INTO bookmarks VALUES ('a.ts');");
 db.close();
 // Replacing identical IDs must preserve external references even with ON DELETE CASCADE.
 main(args);
 const current=readFileSync(output);
 assert.throws(()=>main([...args,'--include','b.ts']),/foreign key constraints/);
 assert.deepEqual(readFileSync(output),current);
 const reopened=new DatabaseSync(output);t.after(()=>reopened.close());
 assert.equal(reopened.prepare('SELECT file_id FROM bookmarks').get().file_id,'a.ts');
 assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM code_files').get().n,2);
 assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('schema creation errors roll back dropped inspector objects',t=>{
 const {dir,args}=fixture(t,{'a.ts':'export function a(){}'});
 main(args);
 const output=path.join(dir,'out.sqlite');
 const db=new DatabaseSync(output);
 db.exec('DROP VIEW code_access_counts; CREATE TABLE code_access_counts (value TEXT);');db.close();
 const before=readFileSync(output);
 assert.throws(()=>main(args));
 assert.deepEqual(readFileSync(output),before);
});

test('stores actual UTF-8 file size in bytes, including BOM and CRLF', t => {
 const text='\uFEFF// Größe 😀\r\nexport const größe = 1;\r\n';
 const {dir,args}=fixture(t,{'size.ts':text});
 const result=main(args);
 assert.equal(result.files[0].size_bytes,Buffer.byteLength(text));
 const db=new DatabaseSync(path.join(dir,'out.sqlite'));t.after(()=>db.close());
 assert.equal(db.prepare('SELECT size_bytes FROM code_files').get().size_bytes,readFileSync(path.join(dir,'size.ts')).length);
 assert.equal(db.prepare("SELECT value FROM code_metadata WHERE key='schema_version'").get().value,'8');
});

test('iteration targets and destructuring defaults are writes; branch aliases retain possible origins', t => {
 const {args}=fixture(t,{'a.ts':`export let state=0;
 export const object={x:""};
 export function loops(xs:number[]) { for(state of xs) {} for(object.x in {a:1}) {} }
 export function branch(p:{x:number}, flag:boolean) { let a={x:0}; if(flag) a=p; a.x=1; }
 export function defaults(p:{x:number}) { ({x:p.x=0}={x:1}); }
 export function primitive(p:{x:number}) { const {x}=p; x.toString(); }
 export const {value}={value:1};
 export function snapshot() { return value; }
 export function objectAlias(p:{x:{y:number}}) { const {x}=p; x.y=1; }
 `});
 const r=main(args),fn=name=>r.functions.find(f=>f.name===name),params=name=>r.parameters.filter(p=>p.function_id===fn(name).id);
 const events=r.accesses.filter(a=>a.function_id===fn('loops').id);
 assert.equal(events.find(a=>a.expression==='state').writes,1);
 assert.equal(events.find(a=>a.expression==='state').reads,0);
 assert.equal(events.find(a=>a.expression==='object.x').mutations,1);
 assert.equal(params('branch')[0].possible_mutation_count,1);
 assert.equal(params('defaults')[0].mutation_count,1);
 assert.equal(params('primitive')[0].possible_mutation_count,0);
 assert.equal(params('objectAlias')[0].mutation_count,1);
 assert.equal(r.accesses.find(a=>a.function_id===fn('snapshot').id).symbol_name,'value');
});

test('exclusive UTF-8 function sizes partition each source without nested double counting', t => {
 const source='// ä\r\nexport function outer(){\r\n const inner=()=>{\r\n return "🍀";\r\n };\r\n return inner();\r\n}\r\nexport const top=1;\r\n';
 const {args,dir}=fixture(t,{'a.ts':source,'plain.ts':'export const value="ä";\n'}),r=main(args);
 const functions=r.functions.filter(f=>f.file_id==='a.ts'),outer=functions.find(f=>f.name==='outer'),inner=functions.find(f=>f.name==='inner'),file=r.files.find(f=>f.id==='a.ts');
 assert.equal(outer.source_size_bytes,outer.exclusive_size_bytes+inner.exclusive_size_bytes);
 assert.equal(file.size_bytes,file.outside_size_bytes+functions.reduce((sum,f)=>sum+f.exclusive_size_bytes,0));
 assert.ok(inner.exclusive_size_bytes>0);assert.ok(outer.exclusive_effective_lines<outer.effective_lines);
 const plain=r.files.find(f=>f.id==='plain.ts');assert.equal(plain.size_bytes,plain.outside_size_bytes);
 const db=new DatabaseSync(path.join(dir,'out.sqlite'));t.after(()=>db.close());
 assert.equal(db.prepare('SELECT exclusive_size_bytes FROM code_functions WHERE id=?').get(inner.id).exclusive_size_bytes,inner.exclusive_size_bytes);
});

test('stores exact imports, reexports, dynamic imports and signatures without source snapshots', t => {
 const {dir,args}=fixture(t, {'b.ts':'export const value=1; export function leaf(x:number){return x;}', 'a.ts':"import {leaf,value} from './b.js'; export {leaf} from './b.js'; export async function load(){const x=value; return import('./b.js');}"});
 main(args);
 const db=new DatabaseSync(path.join(dir,'out.sqlite'));t.after(()=>db.close());
 const imports=db.prepare('SELECT * FROM code_imports ORDER BY id').all();
 assert.equal(db.prepare("SELECT target_file_id FROM code_symbol_references WHERE target_name='value'").get().target_file_id,'b.ts');
 assert.equal(imports.length,3);assert.ok(imports.every(row=>row.target_file_id==='b.ts'));
 assert.deepEqual(imports.map(row=>row.kind),['import','reexport','dynamic']);
 assert.match(db.prepare("SELECT signature FROM code_functions WHERE name='leaf'").get().signature,/number/);
 assert.ok(db.prepare("SELECT name FROM code_exports WHERE file_id='a.ts'").all().some(row=>row.name==='leaf'));
});

test('function traits track class property modifiers without leaking into callbacks and resolve defining-file exports', t => {
 const {dir,args}=fixture(t, {'a.ts':`
 export async function exported() { return 1; }
 export const arrow = async () => 1;
 function local() {} export { local as alias };
 export default function* generator() { yield 1; }
 class Example {
   private static work = async () => { const inner = () => 1; return inner(); };
   protected method() {}
   #secret() {}
   plain() {}
   get value() { return 1; }
   constructor() {}
 }
 const object = { method() {} };
 abstract class Abstract { abstract noBody(): void; }
 `});
 main(args);const db=new DatabaseSync(path.join(dir,'out.sqlite'));t.after(()=>db.close());
 const functions=db.prepare('SELECT * FROM code_functions').all(),get=name=>functions.find(f=>f.name===name);
 assert.equal(get('exported').is_async,1);assert.equal(get('exported').is_exported,1);
 assert.equal(get('arrow').is_exported,1);assert.equal(get('local').is_exported,1);
 assert.equal(get('generator').is_generator,1);assert.equal(get('generator').is_exported,1);
 assert.equal(get('work').visibility,'private');assert.equal(get('work').is_static,1);assert.equal(get('work').is_async,1);
 assert.equal(get('inner').visibility,'not_applicable');assert.equal(get('inner').is_static,0);assert.equal(get('inner').is_async,0);
 assert.equal(get('Example.method').visibility,'protected');assert.equal(get('Example.#secret').visibility,'private');
 assert.equal(get('Example.plain').visibility,'public');assert.equal(get('Example.value').visibility,'public');
 assert.equal(get('method').visibility,'not_applicable');assert.equal(get('method').is_exported,0);
 assert.ok(!functions.some(f=>f.name.includes('noBody')));
});

test('dependency metrics persist cycles, canonical external references, aliases and analysis gaps', t => {
 const {dir,args}=fixture(t,{'a.ts':`import { hidden } from './b.js';
export function A() { console.log(Math.PI); }
export function B() { A(); C(); }
export function C() { B(); }
export function R() { R(); }
export function gap() { hidden(); }
export function dynamic(f:()=>void) { f(); }
export function pass() { console.log(A); }
export function builtinValue() { return undefined; }
`, 'b.ts':'export function hidden() {}'});
 const r=main([...args,'--exclude','b.ts']), byName=new Map(r.functions.map(f=>[f.name,f]));
 assert.equal(byName.get('B').call_depth,1);
 assert.equal(byName.get('C').call_depth,2);
 assert.equal(byName.get('R').reachable_internal_count,1);
 assert.equal(byName.get('B').reachable_external_count,2);
 assert.equal(byName.get('B').reachable_symbol_count,5);
 assert.equal(byName.get('pass').reachable_internal_count,0);
 assert.equal(byName.get('gap').dependency_complete,0);
 assert.equal(byName.get('dynamic').dependency_complete,0);
 assert.equal(byName.get('A').dependency_complete,1);
 const db=new DatabaseSync(path.join(dir,'out.sqlite'));t.after(()=>db.close());
 assert.equal(db.prepare('SELECT call_depth FROM code_functions WHERE name=?').get('C').call_depth,2);
 assert.deepEqual(db.prepare('SELECT DISTINCT name FROM code_external_references ORDER BY name').all().map(r=>r.name),['builtin.Console.log','builtin.Math.PI','builtin.undefined']);
 assert.equal(byName.get('builtinValue').direct_external_count,1);
 assert.ok(db.prepare('SELECT * FROM code_unknown_references WHERE reason=?').get('excluded_internal'));
});

test('package aliases share identity, unused imports are absent, and namespace submodules remain distinct', t => {
 const {dir,args}=fixture(t,{'a.ts':`import { run as execute, unused } from 'pkg';
import * as ns from 'pkg';
import { run as second } from 'pkg/sub';
const alias = execute;
export function use() { execute(); ns.run(); alias(); second(); }
`});
 mkdirSync(path.join(dir,'node_modules/pkg'),{recursive:true});
 writeFileSync(path.join(dir,'node_modules/pkg/index.d.ts'),'export declare function run():void; export declare function unused():void;');
 writeFileSync(path.join(dir,'node_modules/pkg/sub.d.ts'),'export declare function run():void;');
 const r=main(args),f=r.functions.find(f=>f.name==='use');
 assert.equal(f.dependency_complete,1);
 assert.equal(f.call_depth,0);
 assert.equal(f.direct_external_count,2);
 assert.ok(r.externalReferences.some(r=>r.alias==='execute'));
 assert.ok(!r.externalReferences.some(r=>r.name.includes('unused')));
 assert.deepEqual([...new Set(r.externalReferences.map(r=>r.name))].sort(),['pkg.run','pkg/sub.run']);
});
