import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const hash = text => createHash('sha256').update(text).digest('hex');

export function fingerprints(project) {
  // Include implementation changes as well as configuration in the cache contract.
  const engine = ['project','metrics','analyze','incremental','database','termination','main'].map(n => readFileSync(new URL(`./${n}.mjs`, import.meta.url), 'utf8')).join('\n');
  const common = hash(engine + ts.version + project.configs.map(p => readFileSync(p, 'utf8')).join('\n'));
  const output = new Map();
  for (const entry of project.files) {
    const { program, options } = entry;
    const sources = new Map(program.getSourceFiles().map(sf => [path.resolve(sf.fileName), sf]));
    const globals = program.getSourceFiles().filter(sf => !ts.isExternalModule(sf) || sf.isDeclarationFile);
    const seen = new Set();
    function visit(sf) {
      const name = path.resolve(sf.fileName);
      if (seen.has(name)) return;
      seen.add(name);
      const preprocessed = ts.preProcessFile(sf.text, true, true);
      for (const i of preprocessed.importedFiles) {
        const resolved = ts.resolveModuleName(i.fileName, sf.fileName, options, ts.sys).resolvedModule;
        const dependency = resolved && sources.get(path.resolve(resolved.resolvedFileName));
        if (dependency) visit(dependency);
      }
      for (const ref of sf.referencedFiles) {
        const dependency = sources.get(path.resolve(path.dirname(sf.fileName), ref.fileName));
        if (dependency) visit(dependency);
      }
    }
    visit(entry.sf);
    for (const sf of globals) visit(sf);
    // Compiler options include inherited tsconfig settings and module resolution options.
    // Resolved paths and contents capture dependency addition/removal and changed imports.
    const content = [...seen].sort().map(p => [p, hash(sources.get(p).text)]);
    output.set(entry.path, hash(common + JSON.stringify(options) + JSON.stringify(content) + JSON.stringify(project.files.map(f => f.path))));
  }
  return output;
}
