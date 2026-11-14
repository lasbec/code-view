import ts from 'typescript';

// Index once, then follow at most two argument-to-parameter bindings backwards.
// Inferred targets are a union of possibilities, not individual call contexts.
export function callbackResolver(project, { targets, symbol, unwrap, byNode }, { maxHops = 2, workBudget = 100000, targetBudget = 256 } = {}) {
  const incoming = new Map(), escaped = new Set(), written = new Set(), cache = new Map();
  let work = 0;
  const checkerFor = new Map(project.files.map(f => [f.sf, f.checker]));
  function markWritten(n, checker) {
    if (ts.isIdentifier(n)) for (const d of symbol(checker, n)?.declarations ?? []) written.add(d);
    else ts.forEachChild(n, child => markWritten(child, checker));
  }
  for (const { sf, checker } of project.files) {
    function scan(n) {
      if (ts.isTypeNode(n)) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        for (const fn of targets(checker, n.expression)) {
          if (!incoming.has(fn)) incoming.set(fn, []);
          incoming.get(fn).push({ call: n, checker });
        }
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) markWritten(n.left, checker);
      if (ts.isForOfStatement(n) || ts.isForInStatement(n)) markWritten(n.initializer, checker);
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)) markWritten(n.operand, checker);
      // Functions used as values may be invoked outside the indexed call sites.
      if ((ts.isIdentifier(n) && !ts.isDeclarationName(n)) || ts.isPropertyAccessExpression(n)) {
        let wrapped = n;
        while (wrapped.parent && unwrap(wrapped.parent) === n) wrapped = wrapped.parent;
        const direct = (ts.isCallExpression(wrapped.parent) || ts.isNewExpression(wrapped.parent)) && wrapped.parent.expression === wrapped;
        if (!direct) for (const fn of targets(checker, n)) escaped.add(fn);
      }
      ts.forEachChild(n, scan);
    }
    scan(sf);
  }
  const empty = () => ({ targets: [], complete: false });
  function resolve(expr, checker, hops, seen = new Set()) {
    if (++work > workBudget) return empty();
    expr = unwrap(expr);
    if (!expr) return empty();
    const direct = targets(checker, expr);
    if (direct.length) return { targets: direct.slice(0, targetBudget), complete: direct.length <= targetBudget };
    const declarations = symbol(checker, expr)?.declarations ?? [];
    if (declarations.length !== 1) return empty();
    const d = declarations[0];
    if (seen.has(d) || written.has(d)) return empty();
    const nextSeen = new Set([...seen, d]);
    if (ts.isVariableDeclaration(d) && d.parent.flags & ts.NodeFlags.Const && d.initializer) return resolve(d.initializer, checker, hops, nextSeen);
    if (!ts.isParameter(d) || !ts.isIdentifier(d.name) || d.dotDotDotToken || !hops) return empty();
    const fn = d.parent, row = byNode.get(fn), sites = incoming.get(fn) ?? [];
    let entries = cache.get(d);
    if (entries?.has(hops)) return entries.get(hops);
    const found = new Set();
    let complete = !!sites.length && !!row && !row.is_exported && !escaped.has(fn) && !ts.isMethodDeclaration(fn) && !ts.isConstructorDeclaration(fn);
    const index = fn.parameters.indexOf(d);
    for (const { call, checker: siteChecker } of sites) {
      if (++work > workBudget) { complete = false; break; }
      if (call.arguments?.some(ts.isSpreadElement)) { complete = false; continue; }
      const arg = call.arguments?.[index] ?? d.initializer;
      const value = resolve(arg, call.arguments?.[index] ? siteChecker : checkerFor.get(fn.getSourceFile()), hops - 1, nextSeen);
      complete &&= value.complete;
      for (const target of value.targets) {
        if (found.size >= targetBudget && !found.has(target)) { complete = false; break; }
        found.add(target);
      }
      if (found.size >= targetBudget) { complete = false; break; }
    }
    const value = { targets: [...found], complete };
    if (!entries) cache.set(d, entries = new Map());
    entries.set(hops, value);
    return value;
  }
  return (expr, checker) => resolve(expr, checker, maxHops);
}
