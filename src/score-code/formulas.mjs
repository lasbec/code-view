import vm from 'node:vm';
import lodash from 'lodash';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { formulaMetrics } from './catalog.mjs';

export const tools = Object.keys(lodash).filter(key => key !== '_' && /^[A-Za-z_$][\w$]*$/.test(key) && typeof lodash[key] === 'function');
export function formulaBody(code) {
  try { new vm.Script(`(${code}\n)`); return { body: `return (${code}\n);`, expression: true }; }
  catch { return { body: code, expression: false }; }
}
export function defaultName(code, scope) {
  const source = ts.createSourceFile('formula.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const known = new Map(formulaMetrics.filter(m => m.scope === scope).map(m => [m.key, m]));
  let name;
  const visit = node => {
    if (name) return;
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'metrics') name = known.get(node.name.text)?.label;
    if (ts.isElementAccessExpression(node) && node.expression.getText(source) === 'metrics' && ts.isStringLiteral(node.argumentExpression)) name = known.get(node.argumentExpression.text)?.label;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return name ?? (scope === 'function' ? 'Function metric' : 'File metric');
}
const services = new Map();
function language(scope) {
  if (services.has(scope)) return services.get(scope);
  const root = fileURLToPath(new URL('./', import.meta.url));
  const file = `${root}formula-${scope}.js`, globals = `${root}formula-${scope}.d.ts`;
  const metrics = formulaMetrics.filter(m => m.scope === scope).map(m => `/** ${m.label}: ${m.description} */\n readonly ${m.key}: ${m.type};`).join('\n');
  const declarations = `import lodash from 'lodash';\ndeclare global {\nconst _: typeof lodash;\n${tools.map(k => `const ${k}: typeof lodash.${k};`).join('\n')}\n${scope === 'aggregation' ? 'const scores: number[];' : `const metrics: {${metrics}};`}\n}\n`;
  let code = '', version = 0;
  const options = { allowJs: true, checkJs: true, strict: true, noImplicitAny: false, noEmit: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, esModuleInterop: true, types: [], lib: ['lib.es2023.d.ts'] };
  const host = { getScriptFileNames: () => [file, globals], getScriptVersion: p => p === file ? String(version) : '0',
    getScriptSnapshot: p => { const text = p === file ? code : p === globals ? declarations : ts.sys.readFile(p); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
    getCurrentDirectory: () => root, getCompilationSettings: () => options, getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: p => p === file || p === globals || ts.sys.fileExists(p), readFile: p => p === globals ? declarations : ts.sys.readFile(p), readDirectory: ts.sys.readDirectory };
  const service = ts.createLanguageService(host);
  const entry = { set(value) { code = value; version++; }, service, file };
  services.set(scope, entry); return entry;
}
export function inspectFormula(code, scope) {
  const { body, expression } = formulaBody(code);
  const prefix = expression ? 'function calculate(){return (\n' : 'function calculate(){\n';
  const wrapped = prefix + (expression ? `${code}\n);}` : `${body}\n}`);
  const entry = language(scope); entry.set(wrapped);
  const syntactic = entry.service.getSyntacticDiagnostics(entry.file);
  const diagnostics = [...syntactic, ...entry.service.getSemanticDiagnostics(entry.file)].filter(d => syntactic.includes(d) || d.start >= prefix.length && d.start <= prefix.length + code.length).map(d => ({
    from: Math.max(0, Math.min(code.length, d.start - prefix.length)), to: Math.max(0, Math.min(code.length, d.start - prefix.length + (d.length ?? 1))),
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'), severity: 'error', syntax: syntactic.includes(d), code: d.code,
  }));
  return { diagnostics, name: defaultName(code, scope) };
}
export function createEvaluator() {
  // Trusted user code. This context limits accidental access; it is not a security sandbox.
  const library = lodash.runInContext();
  const context = vm.createContext({ _: library, ...Object.fromEntries(tools.map(k => [k, library[k]])) });
  return code => {
    try {
      const fn = new vm.Script(`(function(metrics, scores){"use strict";\n${formulaBody(code).body}\n})`).runInContext(context);
      return (metrics, scores) => {
        try {
          const value = fn(metrics, scores);
          if (value && typeof value.then === 'function') { Promise.resolve(value).catch(() => {}); throw new Error('Asynchronous formulas are not supported.'); }
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Formula must return a finite number.');
          return { value, error: null };
        } catch (error) { return { value: null, error: error?.message ?? String(error) }; }
      };
    } catch (error) { return () => ({ value: null, error: error?.message ?? String(error) }); }
  };
}
