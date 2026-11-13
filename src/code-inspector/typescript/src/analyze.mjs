import ts from 'typescript';
import path from 'node:path';
import { statSync } from 'node:fs';
import { isFunction, walkOwn, lineMetrics, functionMetrics } from './metrics.mjs';
import { slash } from './project.mjs';
import { solveTermination } from './termination.mjs';
const nearestFunction = node => { for (let n = node?.parent; n; n = n.parent) if (isFunction(n)) return n; return null; };
const location = n => { const p = n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()); return { line: p.line + 1, column: p.character + 1 }; };
const bindingNames = n => ts.isIdentifier(n) ? [n] : n.elements.flatMap(e => ts.isOmittedExpression(e) ? [] : bindingNames(e.name));
const assignment = k => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
const unwrap = n => { while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n))) n = n.expression; return n; };
const mutators = new Set(['push','pop','shift','unshift','splice','sort','reverse','fill','copyWithin','set','add','delete','clear']);

export function analyze(project, changedPaths = new Set(project.files.map(f => f.path)), cached = { functions: [], calls: [] }, onFile = () => {}, onIndexed = () => {}, onAnalysis = () => {}) {
  const result = { files: [], functions: [], parameters: [], accesses: [], calls: [], references: [], shadows: [], diagnostics: project.diagnostics };
  const byNode = new Map(), byId = new Map();
  const nodeId = n => `${slash(path.relative(project.base, n.getSourceFile().fileName))}:${n.getStart()}`;
  function symbol(checker, n) {
    let s = checker.getSymbolAtLocation(n);
    if (s?.flags & ts.SymbolFlags.Alias) { try { s = checker.getAliasedSymbol(s); } catch { /* unresolved import */ } }
    return s;
  }
  function targets(checker, expr, seen = new Set()) {
    expr = unwrap(expr);
    if (!expr) return [];
    if (isFunction(expr)) return [expr];
    const s = symbol(checker, ts.isPropertyAccessExpression(expr) ? expr.name : expr);
    if (!s || seen.has(s)) return [];
    seen.add(s);
    return [...new Set((s.declarations ?? []).flatMap(d => {
      if (isFunction(d)) return [d];
      if (ts.isVariableDeclaration(d)) return d.parent.flags & ts.NodeFlags.Const ? targets(checker, d.initializer, seen) : [];
      if (ts.isPropertyDeclaration(d) || ts.isBindingElement(d)) return targets(checker, d.initializer, seen);
      return [];
    }))];
  }
  let indexed = 0;
  for (const entry of project.files) {
    const { sf, checker } = entry;
    const changed = changedPaths.has(entry.path);
    let imports = 0, bindings = 0, dynamic = 0, reexports = 0;
    function scan(n) {
      if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) {
        imports++;
        if (ts.isImportEqualsDeclaration(n)) bindings++;
        else if (n.importClause) { if (n.importClause.name) bindings++; const b = n.importClause.namedBindings; if (b) bindings += ts.isNamedImports(b) ? b.elements.length : 1; }
      }
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) dynamic++;
      if (ts.isExportDeclaration(n) && n.moduleSpecifier) reexports++;
      if (isFunction(n)) {
        const id = nodeId(n), pos = location(n), metrics = changed ? functionMetrics(n, sf) : {};
        let name = n.name?.getText(sf);
        if (ts.isConstructorDeclaration(n)) name = 'constructor';
        if (!name && (ts.isVariableDeclaration(n.parent) || ts.isPropertyAssignment(n.parent) || ts.isPropertyDeclaration(n.parent) || ts.isBinaryExpression(n.parent))) name = n.parent.name?.getText(sf) ?? n.parent.left?.getText(sf);
        name ??= `<anonymous@${pos.line}:${pos.column}>`;
        let container = n.parent;
        while (container && !ts.isClassLike(container)) container = container.parent;
        if (container?.name && (ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isAccessor(n))) name = `${container.name.text}.${name}`;
        const row = { id, file_id: entry.path, parent_function_id: nearestFunction(n) ? nodeId(nearestFunction(n)) : null, name, kind: ts.SyntaxKind[n.kind], ...pos,
          end_line: sf.getLineAndCharacterOfPosition(n.end - 1).line + 1, ...metrics, termination: 'unknown', termination_reason: null };
        if (!changed) Object.assign(row, cached.functions.find(f => f.id === id) ?? { unsafe: true });
        byNode.set(n, row); byId.set(id, row);
        if (changed) result.functions.push(row);
        if (changed) n.parameters.forEach((p, index) => result.parameters.push({ id: `${id}/p${index}`, function_id: id, position: index, name: p.name.getText(sf), type: checker.typeToString(checker.getTypeAtLocation(p)), optional: Number(!!p.questionToken || !!p.initializer), rest: Number(!!p.dotDotDotToken), mutation_count: 0, possible_mutation_count: 0 }));
      }
      ts.forEachChild(n, scan);
    }
    scan(sf);
    if (!changed) { onIndexed(++indexed, project.files.length); continue; }
    const module = checker.getSymbolAtLocation(sf);
    const exports = module ? checker.getExportsOfModule(module) : [];
    const exportedVars = new Set(exports.flatMap(s => {
      if (s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
      return (s.declarations ?? []).filter(d => (ts.isVariableDeclaration(d) || ts.isBindingElement(d)) && d.getSourceFile() === sf && !nearestFunction(d)).map(nodeId);
    }));
    result.files.push({ id: entry.path, size_bytes: statSync(sf.fileName).size, ...lineMetrics(sf), import_statements: imports, imported_bindings: bindings, dynamic_imports: dynamic, reexports, exported_variables: exportedVars.size });
    onIndexed(++indexed, project.files.length);
  }
  onAnalysis();
  for (const { sf, checker, path: filePath } of project.files) {
    if (!changedPaths.has(filePath)) continue;
    // Each identifier declaration belongs to its lexical scope. Query the parent scope
    // with the checker so declarations later in the file and imported names also count.
    function scopeFor(d) {
      if (ts.isParameter(d)) return d.parent;
      let n = d.parent;
      const isVar = ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) && !(d.parent.flags & ts.NodeFlags.BlockScoped);
      for (; n; n = n.parent) {
        if (isFunction(n) || ts.isSourceFile(n)) return n;
        if (!isVar && (ts.isBlock(n) || ts.isCatchClause(n) || ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n))) return n;
      }
      return sf;
    }
    function shadowScan(n) {
      const namedDeclaration = ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n);
      if (namedDeclaration && n.name && ts.isIdentifier(n.name)) {
        const scope = scopeFor(n), own = checker.getSymbolAtLocation(n.name);
        if (scope.parent) {
          const outer = checker.getSymbolsInScope(scope.parent, ts.SymbolFlags.Value | ts.SymbolFlags.Alias).find(s => s.name === n.name.text && s !== own);
          const owner = ts.isParameter(n) ? (isFunction(n.parent) ? n.parent : null) : nearestFunction(n);
          if (outer && owner && byNode.has(owner)) result.shadows.push({ function_id: nodeId(owner), name: n.name.text, ...location(n.name), hidden_symbol: checker.getFullyQualifiedName(outer), hidden_declaration: outer.declarations?.[0] ? nodeId(outer.declarations[0]) : null });
        }
      }
      ts.forEachChild(n, shadowScan);
    }
    shadowScan(sf);
    let activeRoots = null;
    function root(expr, seen = new Set()) {
      expr = unwrap(expr);
      if (!expr) return null;
      if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) return root(expr.expression, seen);
      if (expr.kind === ts.SyntaxKind.ThisKeyword || expr.kind === ts.SyntaxKind.SuperKeyword) return { thisRoot: true, expr };
      if (!ts.isIdentifier(expr)) return null;
      const s = symbol(checker, expr);
      if (!s || seen.has(s)) return null;
      seen.add(s);
      const d = s.valueDeclaration ?? s.declarations?.[0];
      if (activeRoots?.has(d)) return activeRoots.get(d);
      if (d && ts.isBindingElement(d)) {
        let container = d.parent;
        while (ts.isBindingPattern(container) || ts.isBindingElement(container)) container = container.parent;
        if (ts.isParameter(container)) return { symbol: s, declaration: container, expr };
        if (ts.isVariableDeclaration(container) && container.initializer && container.parent.flags & ts.NodeFlags.Const) {
          const origin = root(container.initializer, seen);
          if (origin) return origin;
        }
      }
      if (d && ts.isVariableDeclaration(d) && d.initializer && d.parent.flags & ts.NodeFlags.Const) {
        const value = unwrap(d.initializer);
        if ((checker.getTypeAtLocation(value).flags & (ts.TypeFlags.Object | ts.TypeFlags.Any | ts.TypeFlags.TypeParameter)) && (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))) {
          const r = root(value, seen); if (r) return r;
        }
      }
      return { symbol: s, declaration: d, expr };
    }
    function referenceKind(n) {
      let p = n;
      while (p.parent && (ts.isPropertyAccessExpression(p.parent) && p.parent.name === p || ts.isParenthesizedExpression(p.parent) || ts.isAsExpression(p.parent) || ts.isNonNullExpression(p.parent))) p = p.parent;
      if ((ts.isCallExpression(p.parent) || ts.isNewExpression(p.parent)) && p.parent.expression === p) return 'direct_call';
      if (ts.isCallExpression(p.parent) || ts.isNewExpression(p.parent)) return 'argument';
      if (ts.isReturnStatement(p.parent) || ts.isArrowFunction(p.parent) && p.parent.body === p) return 'return';
      if (ts.isExportSpecifier(p.parent) || ts.isExportAssignment(p.parent)) return 'export';
      if (ts.isVariableDeclaration(p.parent) || ts.isPropertyAssignment(p.parent) || ts.isBinaryExpression(p.parent) && assignment(p.parent.operatorToken.kind)) return 'assignment';
      return 'other';
    }
    function runtimeName(n) {
      if (!ts.isIdentifier(n)) return false;
      const p = n.parent;
      if (ts.isDeclarationName(n) && !(ts.isShorthandPropertyAssignment(p))) return false;
      if ((ts.isPropertyAccessExpression(p) && p.name === n) || ts.isQualifiedName(p) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p) || ts.isExportSpecifier(p)) return false;
      if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === n) return false;
      return true;
    }
    function scan(n, owner = null) {
      if (isFunction(n)) owner = byNode.get(n);
      if (ts.isTypeNode(n)) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        let candidates = targets(checker, n.expression);
        const signature = checker.getResolvedSignature(n), decl = signature?.declaration;
        if (decl && isFunction(decl) && !candidates.length) candidates = [decl];
        const target = candidates.length === 1 ? nodeId(candidates[0]) : null;
        result.calls.push({ caller_id: owner?.id ?? null, file_id: filePath, target_id: target && byId.has(target) ? target : null, target_name: n.expression.getText(sf), resolution: target && byId.has(target) ? 'resolved' : candidates.length > 1 ? 'ambiguous' : 'unknown', kind: ts.isNewExpression(n) ? 'construct' : 'call', ...location(n) });
        if (owner && (!target || !byId.has(target))) owner.unsafe = true;
      }
      if (runtimeName(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isExportSpecifier(n)) {
        const candidates = targets(checker, ts.isExportSpecifier(n) ? (n.propertyName ?? n.name) : n);
        for (const target of candidates) result.references.push({ function_id: owner?.id ?? null, file_id: filePath, target_id: byId.has(nodeId(target)) ? nodeId(target) : null, target_name: n.getText(sf), kind: ts.isExportSpecifier(n) ? 'export' : referenceKind(n), ...location(n) });
      }
      ts.forEachChild(n, c => scan(c, owner));
    }
    scan(sf);
    for (const [fn, row] of byNode) {
      if (fn.getSourceFile() !== sf) continue;
      activeRoots = new Map();
      function record(expr, mode, effect = 'definite', viaCall = false) {
        expr = unwrap(expr);
        const r = root(expr); if (!r || r.localRoot) return;
        if (r.possible) effect = 'possible';
        const property = ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr);
        const mutating = mode === 'mutate' || property && mode !== 'read';
        const d = r.declaration, declaredIn = d ? nearestFunction(d) : null;
        let scope, parameter = null;
        if (r.thisRoot) {
          if (!property && !viaCall) return;
          scope = 'class_field';
        } else if (declaredIn === fn) {
          if (d && ts.isParameter(d) && mutating) {
            scope = 'parameter';
            const index = fn.parameters.indexOf(d);
            parameter = result.parameters.find(p => p.id === `${row.id}/p${index}`);
          } else return;
        } else {
          if (!(r.symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property))) return;
          scope = declaredIn ? 'outer_function' : d && ts.isExternalModule(d.getSourceFile()) ? 'module' : 'global';
        }
        const field = property ? symbol(checker, ts.isPropertyAccessExpression(expr) ? expr.name : expr.argumentExpression) : null;
        if (!parameter && field?.declarations?.some(d => ts.isPropertyDeclaration(d) || ts.isParameter(d) && ts.isParameterPropertyDeclaration(d, d.parent))) scope = 'class_field';
        const write = mode !== 'read', read = mode === 'read' || mode === 'read_write' || mode === 'mutate';
        result.accesses.push({ function_id: row.id, scope, symbol_name: r.symbol?.getName() ?? 'this', symbol_declaration: d ? nodeId(d) : null, expression: expr.getText(sf), parameter_id: parameter?.id ?? null, reads: Number(read), writes: Number(write && !mutating), mutations: Number(mutating), effect, ...location(expr) });
        if (parameter && mutating) parameter[effect === 'definite' ? 'mutation_count' : 'possible_mutation_count']++;
      }
      function access(n) {
        if (n !== fn && isFunction(n) || ts.isTypeNode(n)) return;
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) && n.parent.flags & ts.NodeFlags.Const) {
          const t = checker.getTypeAtLocation(n.initializer);
          if (t.flags & (ts.TypeFlags.Object | ts.TypeFlags.Any | ts.TypeFlags.TypeParameter)) {
            const origin = root(n.initializer);
            if (origin) activeRoots.set(n, origin);
          }
        }
        if (ts.isCallExpression(n)) {
          const e = unwrap(n.expression);
          if (ts.isPropertyAccessExpression(e)) {
            const type = checker.getTypeAtLocation(e.expression), name = type.symbol?.name;
            const standard = checker.isArrayType(type) || checker.isTupleType(type) || ['Map','Set','WeakMap','WeakSet'].includes(name) && type.symbol.declarations?.some(d => /[\\/]typescript[\\/]lib[\\/]lib\./.test(d.getSourceFile().fileName));
            const mutates = standard && mutators.has(e.name.text);
            record(e.expression, 'mutate', mutates ? 'definite' : 'possible', true);
          }
          for (const a of n.arguments) {
            const t = checker.getTypeAtLocation(a);
            if (t.flags & (ts.TypeFlags.Object | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter) || t.isUnion?.() && t.types.some(t => t.flags & ts.TypeFlags.Object)) record(a, 'mutate', 'possible', true);
          }
        }
        if (ts.isBinaryExpression(n) && assignment(n.operatorToken.kind)) {
          const mode = n.operatorToken.kind === ts.SyntaxKind.EqualsToken ? 'write' : 'read_write';
          writeTarget(n.left, mode); access(n.right);
          const left = unwrap(n.left);
          if (ts.isIdentifier(left) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const s = symbol(checker, left), d = s?.valueDeclaration;
            if (d && nearestFunction(d) === fn) {
              let conditional = false;
              for (let p = n.parent; p && p !== fn; p = p.parent) {
                if (ts.isIfStatement(p) || ts.isConditionalExpression(p) || ts.isSwitchStatement(p) || ts.isIterationStatement(p, false) || ts.isTryStatement(p) || ts.isBinaryExpression(p) && [ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) conditional = true;
              }
              const origin = root(n.right) ?? { localRoot: true };
              if (conditional) { const previous = root(left); if (previous) activeRoots.set(d, { ...previous, possible: true }); }
              else activeRoots.set(d, origin);
            }
          }
          return;
        }
        if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)) { writeTarget(n.operand, 'read_write'); return; }
        if (ts.isDeleteExpression(n)) { writeTarget(n.expression, 'write'); return; }
        if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
          record(n, 'read');
          if (ts.isElementAccessExpression(n)) access(n.argumentExpression);
          // Computed/call receivers can themselves have runtime accesses.
          if (!root(n)) access(n.expression);
          return;
        }
        if (runtimeName(n)) record(n, 'read');
        ts.forEachChild(n, access);
      }
      function writeTarget(n, mode) {
        n = unwrap(n);
        if (ts.isArrayLiteralExpression(n)) { for (const e of n.elements) writeTarget(e, mode); return; }
        if (ts.isObjectLiteralExpression(n)) { for (const e of n.properties) writeTarget(ts.isPropertyAssignment(e) ? e.initializer : ts.isShorthandPropertyAssignment(e) ? e.name : e.expression, mode); return; }
        if (ts.isSpreadElement(n) || ts.isSpreadAssignment(n)) { writeTarget(n.expression, mode); return; }
        record(n, mode);
        if (ts.isElementAccessExpression(n)) access(n.argumentExpression);
        if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && !root(n)) access(n.expression);
      }
      access(fn);
      row.termination_candidate = Number(!row.unsafe);
    }
    onFile(result, result.files.find(f => f.id === filePath));
  }
  const states = solveTermination([...byId.values()], [...result.calls, ...cached.calls.filter(c => !changedPaths.has(c.file_id))]);
  for (const row of result.functions) {
    Object.assign(row, states.get(row.id));
    row.shadowing_count = result.shadows.filter(s => s.function_id === row.id).length;
    delete row.unsafe;
  }
  return result;
}
