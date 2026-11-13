import ts from 'typescript';
import path from 'node:path';
import { minimatch } from 'minimatch';

export const slash = p => p.split(path.sep).join('/');
export function loadProject(configPath, includes = [], excludes = []) {
  configPath = path.resolve(configPath);
  const base = path.dirname(configPath), seen = new Set(), files = new Map(), diagnostics = [];
  function load(config) {
    if (seen.has(config)) return;
    seen.add(config);
    const read = ts.readConfigFile(config, ts.sys.readFile);
    if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(config), undefined, config);
    const errors = parsed.errors.filter(d => !(config !== configPath && d.code === 18003));
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: x => x, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n',
    }));
    for (const d of parsed.errors.filter(d => d.code === 18003)) diagnostics.push({
      file: slash(path.relative(base, config)), line: null, code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    });
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
    const syntax = program.getSyntacticDiagnostics();
    if (syntax.length) throw new Error(ts.formatDiagnostics(syntax, {
      getCanonicalFileName: x => x, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n',
    }));
    for (const d of program.getSemanticDiagnostics()) diagnostics.push({
      file: d.file ? slash(path.relative(base, d.file.fileName)) : null,
      line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null,
      code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    });
    for (const name of parsed.fileNames) {
      const sf = program.getSourceFile(name), relative = slash(path.relative(base, name));
      if (!sf || sf.isDeclarationFile || /(^|\/)node_modules\//.test(relative)) continue;
      if (includes.length && !includes.some(g => minimatch(relative, g, { dot: true }))) continue;
      if (excludes.some(g => minimatch(relative, g, { dot: true }))) continue;
      files.set(path.resolve(name), { sf, checker: program.getTypeChecker(), program, options: parsed.options, path: relative });
    }
    for (const ref of parsed.projectReferences ?? []) load(ts.resolveProjectReferencePath(ref));
  }
  load(configPath);
  return { configPath, base, files: [...files.values()].sort((a,b) => a.path.localeCompare(b.path)), diagnostics, includes, excludes, configs: [...seen] };
}
