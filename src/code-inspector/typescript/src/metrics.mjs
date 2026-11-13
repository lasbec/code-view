import ts from 'typescript';
export const isFunction = n => (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) && !!n.body;
export function walkOwn(node, visit) {
  function walk(n) { if (n !== node && isFunction(n)) return; visit(n); ts.forEachChild(n, walk); }
  walk(node);
}
export function lineMetrics(sf, start = 0, end = sf.text.length, excluded = []) {
  // AST literal boundaries prevent // inside regexes, strings and templates becoming comments.
  const literals = new Map();
  function collect(n) {
    if (ts.isStringLiteral(n) || ts.isRegularExpressionLiteral(n) || ts.isTemplateLiteralToken(n)) literals.set(n.getStart(sf), n.end);
    ts.forEachChild(n, collect);
  }
  collect(sf);
  const code = new Set(), comments = new Set();
  const scanner = ts.createScanner(sf.languageVersion, false, sf.languageVariant, sf.text);
  scanner.setTextPos(start);
  function mark(set, a, b) {
    for (let p = a; p < b; p++) if (!excluded.some(([a, b]) => p >= a && p < b) && !/\s/.test(sf.text[p])) set.add(sf.getLineAndCharacterOfPosition(p).line);
  }
  while (scanner.getTextPos() < end) {
    const token = scanner.scan(), a = scanner.getTokenPos();
    if (token === ts.SyntaxKind.EndOfFileToken) break;
    const literalEnd = literals.get(a);
    if (literalEnd) scanner.setTextPos(literalEnd);
    const b = Math.min(scanner.getTextPos(), end);
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) mark(comments, a, b);
    else if (token > ts.SyntaxKind.LastTriviaToken) mark(code, a, b);
  }
  const first = sf.getLineAndCharacterOfPosition(start).line;
  const last = sf.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line;
  const total = end > start ? last - first + 1 : 0;
  const commentOnly = [...comments].filter(l => !code.has(l)).length;
  return { total_lines: total, blank_lines: total - code.size - commentOnly, comment_lines: commentOnly, lines_with_comments: comments.size, effective_lines: code.size };
}
const loops = n => ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n);
const logical = n => ts.isBinaryExpression(n) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind);
export function functionMetrics(fn, sf) {
  let cyclomatic = 1, cognitive = 0, max = 0, unsafe = false;
  function walk(n, depth) {
    if (n !== fn && isFunction(n)) return;
    const control = ts.isIfStatement(n) || loops(n) || ts.isSwitchStatement(n) || ts.isCatchClause(n) || ts.isConditionalExpression(n);
    if (control) {
      max = Math.max(max, depth + 1);
      cognitive += 1 + depth;
      if (!ts.isSwitchStatement(n)) cyclomatic++;
    }
    if (ts.isCaseClause(n) || logical(n)) cyclomatic++;
    if (logical(n)) cognitive++;
    if (ts.isIfStatement(n) && n.elseStatement && !ts.isIfStatement(n.elseStatement)) cognitive++;
    if (ts.isBreakStatement(n) && n.label || ts.isContinueStatement(n) && n.label) cognitive++;
    if (loops(n) || ts.isAwaitExpression(n) || ts.isYieldExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isThrowStatement(n)) unsafe = true;
    ts.forEachChild(n, c => walk(c, depth + Number(control)));
  }
  walk(fn, 0);
  const nested = [];
  function ranges(n) {
    if (n !== fn && isFunction(n)) { nested.push([n.getStart(sf), n.end]); return; }
    ts.forEachChild(n, ranges);
  }
  ranges(fn);
  const start = fn.getStart(sf), source_size_bytes = Buffer.byteLength(sf.text.slice(start, fn.end));
  const exclusive_size_bytes = source_size_bytes - nested.reduce((sum, [a, b]) => sum + Buffer.byteLength(sf.text.slice(a, b)), 0);
  const exclusive_effective_lines = lineMetrics(sf, start, fn.end, nested).effective_lines;
  return { source_size_bytes, exclusive_size_bytes, exclusive_effective_lines, ...lineMetrics(sf, fn.getStart(sf), fn.end), max_nesting: max, cyclomatic_complexity: cyclomatic, cognitive_complexity: cognitive, unsafe };
}
