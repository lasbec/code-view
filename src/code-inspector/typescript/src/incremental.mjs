import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const hash = text => createHash('sha256').update(text).digest('hex');

export function fingerprints(project, onFile = () => {}) {
  // Include implementation changes as well as configuration in the cache contract.
  const engine = ['project','metrics','analyze','incremental','database','termination','main','dependencies','graph'].map(n => readFileSync(new URL(`./${n}.mjs`, import.meta.url), 'utf8')).join('\n');
  const common = hash(engine + ts.version + project.configs.map(p => readFileSync(p, 'utf8')).join('\n'));
  const output = new Map(), contexts = new Map();
  const selection = JSON.stringify(project.files.map(f => f.path));
  for (const entry of project.files) {
    const { program, options } = entry;
    let context = contexts.get(program);
    if (!context) {
      const sourceFiles = program.getSourceFiles();
      const sources = new Map(sourceFiles.map(sf => [path.resolve(sf.fileName), sf]));
      const dependencies = new Map(), hashes = new Map();
      function visit(sf, seen) {
        const pending = [sf];
        while (pending.length) {
          const current = pending.pop(), name = path.resolve(current.fileName);
          if (seen.has(name)) continue;
          seen.add(name);
          if (!dependencies.has(name)) {
            const imported = ts.preProcessFile(current.text, true, true).importedFiles.map(i => {
              const resolved = ts.resolveModuleName(i.fileName, current.fileName, options, ts.sys).resolvedModule;
              return resolved && sources.get(path.resolve(resolved.resolvedFileName));
            });
            const referenced = current.referencedFiles.map(ref => sources.get(path.resolve(path.dirname(current.fileName), ref.fileName)));
            dependencies.set(name, [...imported, ...referenced].filter(Boolean));
          }
          pending.push(...dependencies.get(name));
        }
      }
      const globals = new Set();
      for (const sf of sourceFiles) if (!ts.isExternalModule(sf) || sf.isDeclarationFile) visit(sf, globals);
      context = { sources, hashes, visit, globals };
      contexts.set(program, context);
    }
    const { sources, hashes, visit, globals } = context;
    const seen = new Set(globals);
    visit(entry.sf, seen);
    // Reuse dependency resolution and content hashes, preserving per-file closures.
    const content = [...seen].sort().map(p => {
      if (!hashes.has(p)) hashes.set(p, hash(sources.get(p).text));
      return [p, hashes.get(p)];
    });
    output.set(entry.path, hash(common + JSON.stringify(options) + JSON.stringify(content) + selection));
    onFile(output.size, project.files.length);
  }
  return output;
}
