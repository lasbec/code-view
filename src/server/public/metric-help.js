// These entries describe the numeric columns and row counts exposed by listMetrics.
const entries = [];
function add(table, field, short, long, example) {
  entries.push({ metric: `${table}.${field}`, short, long, example });
}
function count(table, short, long, example) { add(table, 'count', short, long, example); }
const lineFields = [
  ['total_lines', 'All source lines.', 'Includes code, comment-only and blank lines. A trailing newline does not add a line.', 'Three code lines, two comment-only lines and one blank line give 6.'],
  ['blank_lines', 'Lines without code or comments.', 'Counts lines with no code token and no comment text.', 'Two empty lines between declarations give 2.'],
  ['comment_lines', 'Comment-only lines.', 'Counts lines containing comment text but no code. Mixed code/comment lines are excluded.', '// explanation gives 1; const x = 1; // explanation gives 0.'],
  ['lines_with_comments', 'Lines containing comments.', 'Includes comment-only lines and lines combining code and comments. These categories overlap with effective_lines.', 'One comment-only line and one code line with an inline comment give 2.'],
  ['effective_lines', 'Lines containing code.', 'Counts lines with source tokens, including braces and mixed code/comment lines. Multiple statements on one line still count once.', 'const a = 1; const b = 2; on one line gives 1.'],
];
for (const table of ['code_files', 'code_functions']) {
  for (const [field, short, long, example] of lineFields) add(table, field, short,
    `${long} ${table === 'code_files' ? 'Measured once for each file.' : 'Measured over each function span and summed per file. Nested function spans overlap, so their lines can count more than once.'}`, example);
}
add('code_files', 'size_bytes', 'File size in bytes.', 'The source file size on disk, including comments, whitespace and line endings. UTF-8 characters may use multiple bytes. This is the default rectangle area metric.', 'Files of 1,024 and 2,048 bytes have an area ratio of 1:2.');
add('code_files', 'import_statements', 'Static import statements.', 'Counts static imports, including side-effect imports and TypeScript import = declarations. Dynamic import() calls are separate.', 'import { a, b } from "./lib"; gives 1 statement.');
add('code_files', 'imported_bindings', 'Names introduced by imports.', 'Each named binding counts once. Default imports, namespace imports and import = each count once; side-effect imports introduce no binding.', 'import main, { a, b } from "./lib"; gives 3; import "./setup"; gives 0.');
add('code_files', 'dynamic_imports', 'Dynamic import() call sites.', 'Counts syntactic import() calls anywhere in the file. It does not measure how often they execute.', 'const load = () => import("./page"); gives 1.');
add('code_files', 'reexports', 'Export declarations with a module source.', 'Counts export declarations referring to another module. Each declaration counts once, regardless of how many names it reexports.', 'export { a, b } from "./lib"; gives 1; export { a }; gives 0.');
add('code_files', 'exported_variables', 'Distinct exported module variables.', 'Counts exported variable declarations belonging to this file, including variables exported later by name. Functions, classes and variables declared in another file are excluded.', 'const a = 1; export { a }; export const b = 2; gives 2.');
count('code_files', 'Inspected file rows.', 'Each inspected file contributes 1. As the area metric, this gives every file the same rectangle area.', 'Three inspected files each receive a value of 1.');
count('code_functions', 'Implemented functions per file.', 'Counts function declarations, expressions, arrows, methods, constructors, getters and setters with bodies, including nested functions. Overload signatures without bodies are excluded.', 'function outer() { return () => 1; } gives 2.');
add('code_functions', 'max_nesting', 'Sum of function nesting depths.', 'Each function records its maximum simultaneous depth of if, loops, switch, catch and ternary expressions. These maxima are summed per file, not maximized across the file. Else-if increases depth. Nested function control flow is measured separately.', 'Two functions with maximum depths 2 and 3 give a file value of 5.');
add('code_functions', 'cyclomatic_complexity', 'Sum of function branch complexity.', 'Each function starts at 1. Add 1 per if, loop, catch, ternary expression, non-default case, &&, || and ??. Switch itself and plain else add nothing. Inner functions are measured separately. This is static branching, not execution frequency.', 'function choose(x) { if (x) return 1; return 0; } has complexity 2. Two such functions give 4.');
add('code_functions', 'cognitive_complexity', 'Sum of nesting-weighted control flow.', 'Each if, loop, switch, catch and ternary adds 1 plus its control-structure depth. Each &&, ||, ??, plain else and labeled break/continue adds 1. Else-if increases depth. This is the local analyzer rule, not the complete Sonar definition.', 'function f(a, b) { if (a) { if (b) return 1; } return 0; } gives 1 + 2 = 3.');
add('code_functions', 'termination_candidate', 'Functions passing the local termination checks.', 'Sums a 0/1 flag set before call-graph evaluation. Loops, await, yield, property/element access, throw, new and tagged templates block candidacy. A candidate can still have unknown termination because of recursion or uncertain calls. This is not a runtime proof.', 'function f() { return 1; } is a candidate. function g() { while (true) {} } is not.');
add('code_functions', 'shadowing_count', 'Shadowing declarations assigned to functions.', 'Sums declarations that hide a value symbol in an enclosing scope. Includes parameters; names used only as types are excluded. Events in nested functions belong to the nested function.', 'const value = 1; function f(value: number) { return value; } gives 1.');
count('code_file_function_counts', 'File rows in the function-count view.', 'Counts view rows, not functions. There is one row per inspected file, including files with no functions.', 'A file with 0 functions and a file with 8 functions both have this value 1.');
add('code_file_function_counts', 'function_count', 'Implemented functions per file.', 'The function-count view counts implemented functions, including nested functions. It has one row per file. Its numeric function_count agrees with code_functions.count.', 'A function containing two arrow callbacks gives 3.');
add('code_parameters', 'position', 'Sum of zero-based parameter positions.', 'Positions restart at 0 for every function. This sums ordinal positions rather than counting parameters and usually makes a poor size or risk metric.', 'A function with three parameters contributes 0 + 1 + 2 = 3.');
add('code_parameters', 'optional', 'Optional or defaulted parameters.', 'Sums the optional flag for parameters marked with ? or supplied with a default value.', 'function f(a: number, b?: number, c = 0) {} gives 2.');
add('code_parameters', 'rest', 'Rest parameters.', 'Sums the rest flag, with 1 for each parameter declared using ... .', 'function f(...items: number[]) {} gives 1.');
add('code_parameters', 'mutation_count', 'Definite parameter-object mutation sites.', 'Counts recognized mutations of passed objects, including direct property writes, simple const aliases and known Array/Map/Set mutators. Plain parameter reassignment is excluded. Counts source sites, not runtime changes.', 'function f(p: { x: number }) { p.x = 1; p.x++; } gives 2.');
add('code_parameters', 'possible_mutation_count', 'Possible parameter-object mutation sites.', 'Counts uncertain effects such as passing an object to an unknown function, unknown method calls or uncertain aliases. These are possibilities, not confirmed changes. There is no complete analysis of effects across functions.', 'function f(p: object) { external(p); } can record one possible mutation.');
count('code_parameters', 'Declared parameters per file.', 'Counts parameters of analyzed functions, including nested functions. A destructuring parameter is one parameter row.', 'function f({ x, y }: Point, z = 0) {} gives 2.');
for (const table of ['code_accesses', 'code_access_counts']) {
  const context = table === 'code_access_counts' ? 'The view groups events by function, scope and effect certainty, then sums their flags. Its per-file sums agree with the raw access flags.' : 'Events cover outer-function, module, global and class-field state plus parameter-object mutations. Local variables and plain parameter reassignment are excluded. Possible effects are included.';
  add(table, 'reads', 'Recorded state-read flags.', `Sums reads across recorded access sites. A read can occur at the same site as a write or mutation. ${context}`, 'let total = 0; function f() { return total; } gives 1.');
  add(table, 'writes', 'Recorded root-reassignment flags.', `Sums assignments to the root symbol of external state. Property changes count as mutations instead. ${context}`, 'let total = 0; function f() { total++; } gives 1 write and 1 read.');
  add(table, 'mutations', 'Recorded object-mutation flags.', `Sums changes to referenced objects, including definite and possible effects. A chain such as obj.a.b is one root access. ${context}`, 'function f(p: { x: number }) { p.x = 1; } gives 1 mutation and 0 root writes.');
}
count('code_accesses', 'Recorded state-access events.', 'Counts access rows, including parameter-object mutation events. One row may carry multiple flags, so this need not equal reads + writes + mutations. Counts static sites, not executions.', 'An external counter++ is one event carrying both read and write flags.');
count('code_access_counts', 'Distinct access-summary groups.', 'Counts groups of function, scope and effect certainty. This counts neither individual accesses nor distinct variables.', 'Ten module reads with the same certainty in one function form one group.');
count('code_calls', 'Call and constructor sites per file.', 'Counts calls and new expressions, including calls at module scope. Resolved, ambiguous and unknown targets are all included. Calling one function at two source locations counts twice.', 'run(); run(); new Item(); gives 3.');
add('code_call_counts', 'call_count', 'Call sites inside analyzed functions.', 'Sums call-site counts grouped by caller, target ID, target name and resolution. The treemap joins this view through the caller function, so calls at module scope are excluded. code_calls.count includes them.', 'function f() { run(); run(); } run(); gives 2 here and 3 for code_calls.count.');
count('code_call_counts', 'Distinct call-summary groups inside functions.', 'Counts caller/target/name/resolution groups joined to an analyzed caller function. Repeated calls in the same group count once; module-scope callers are excluded.', 'function f() { run(); run(); other(); } gives 2 groups.');
count('code_function_references', 'Recorded function uses.', 'Counts recorded uses, including direct calls, arguments, assignments, returns, exports and other references. Import declarations alone do not count. Includes module-scope uses and targets outside the analyzed set.', 'Passing a known function to register(handler) records a use of handler even though it is not directly called there.');
count('code_shadowing', 'Recorded shadowing declarations in functions.', 'Counts shadowing rows joined to an enclosing analyzed function. Module-scope rows without an enclosing function do not contribute. Matches the sum of code_functions.shadowing_count.', 'const x = 1; function f() { const x = 2; } gives 1.');
add('code_diagnostics', 'code', 'Sum of TypeScript diagnostic identifiers.', 'Diagnostic codes identify error kinds. Their numeric sum has no severity meaning and usually should not be used as a score. Only diagnostics mapped to inspected files contribute.', 'Codes 2322 and 2345 sum to 4667; this does not mean the file is more severe than one with code 7006.');
count('code_diagnostics', 'Compiler diagnostics per inspected file.', 'Counts semantic TypeScript diagnostics associated with the file. Diagnostics from unselected files or without a matching file do not contribute. This is a diagnostic count, not a runtime failure count.', 'Two type errors associated with a file give 2 regardless of their diagnostic codes.');
for (const [table, subject] of [
  ['code_functions', 'function starts'], ['code_accesses', 'access sites'], ['code_calls', 'call sites'],
  ['code_function_references', 'function uses'], ['code_shadowing', 'shadowing declarations'], ['code_diagnostics', 'diagnostics'],
]) {
  add(table, 'line', `Sum of line numbers for ${subject}.`, `Sums 1-based source line positions for ${subject} in the file. This is a location sum, not a line count or complexity measure. Moving code downward changes it without changing behavior. Missing positions contribute 0.`, 'Two records on lines 10 and 30 give 40.');
  if (table !== 'code_diagnostics') add(table, 'column', `Sum of column numbers for ${subject}.`, `Sums 1-based source columns for ${subject}, measured in UTF-16 code units. This is a location sum, not a count. Indentation can change it.`, 'Two records starting at columns 1 and 5 give 6.');
}
add('code_functions', 'end_line', 'Sum of function end-line numbers.', 'Sums the 1-based inclusive final line of each function. This is not function length; use total_lines or effective_lines to measure size.', 'Functions ending on lines 20 and 50 give 70, regardless of their start lines.');

const gitScope = 'Only imported commits associated with the file through a recorded change contribute. Date filters use committed_at, with inclusive boundaries. Paths use the recorded destination path; renames are not followed as one persistent file identity.';
count('git_file_changes', 'Recorded Git file changes.', `Counts file-change rows, including additions, modifications, deletions, renames and copies. Includes merges, whose changes are compared with the first parent. This measures change events, not changed lines. ${gitScope}`, 'A file changed in five regular commits and two merges normally gives 7.');
add('git_file_changes', 'position', 'Sum of file-change output positions.', `Sums zero-based positions of file-change rows within each commit's diff output. This is an output-order detail, not churn or severity. ${gitScope}`, 'A file recorded at positions 0, 2 and 5 in three commits gives 7.');
add('git_file_changes', 'similarity', 'Sum of reported Git similarity percentages.', `Adds similarity/status percentages supplied by Git, usually for rename/copy records. Missing values contribute 0 and can produce a warning. This is neither an average nor a file-quality score. ${gitScope}`, 'Two rename records with similarities 80 and 90 give 170; their average would be 85.');
count('git_commits', 'Imported commits changing the file.', `Counts distinct commit/file associations, including regular commits and merges. A commit changing many files contributes once to each changed file. ${gitScope}`, 'Three distinct commits that each change a file give that file 3.');
add('git_commits', 'parent_count', 'Sum of parent counts of associated commits.', `A root commit contributes 0, an ordinary commit 1 and a two-parent merge 2. This measures commit ancestry, not the number of changes. ${gitScope}`, 'One root commit, three ordinary commits and one two-parent merge give 0 + 3 + 2 = 5.');
add('git_commits', 'is_merge', 'Merge commits changing the file.', `Sums the merge flag, which is 1 for commits with more than one parent. A merge only contributes to files recorded as changed against its first parent. This does not prove that a conflict occurred. ${gitScope}`, 'Four regular commits and two merge commits changing a file give 2.');
count('git_commit_parents', 'Parent relationships for associated commits.', `Counts parent rows, so an ordinary commit contributes 1 and a two-parent merge contributes 2. Agrees with git_commits.parent_count for complete data. ${gitScope}`, 'Two regular commits plus a two-parent merge give 4 parent rows.');
add('git_commit_parents', 'position', 'Sum of zero-based parent positions.', `The first parent is position 0, the second 1 and so on. Sums these positions for commits associated with the file. This is an ancestry-order detail, not a change count. ${gitScope}`, 'An ordinary commit contributes 0; a two-parent merge contributes 0 + 1 = 1.');
count('git_merge_analysis', 'Merge reconstruction records for the file.', `Counts merge-analysis rows with clean, conflicts or unknown status. It does not count only conflicts. Reconstruction uses the installed Git version; unsupported or failed reconstructions remain unknown. ${gitScope}`, 'Two clean merges and one unknown reconstruction changing a file give 3.');
count('git_merge_conflict_files', 'Merge/file records with unresolved conflict stages.', `Counts reconstructed merges where Git reports unresolved conflict stages for this path. This is retrospective reconstruction, not proof of historical conflicts or who resolved them. Conflicts without such file entries do not contribute. ${gitScope}`, 'A file listed with unresolved stages in two reconstructed merges gives 2.');
count('git_merge_conflicts', 'Conflict messages mapped to the file.', `Counts structured conflict-message records mapped to the file through conflict paths. Multiple messages in one merge can contribute. Older messages without path mappings do not contribute. This can differ from git.conflict_count. ${gitScope}`, 'One merge with two structured conflict messages mapped to a file gives 2.');
add('git_merge_conflicts', 'position', 'Sum of conflict-message positions.', `Sums zero-based message positions for structured conflict messages mapped to the file. This describes output order, not severity or number of conflicts. ${gitScope}`, 'Mapped messages at positions 0 and 2 give 2.');
count('git_merge_conflict_paths', 'Structured conflict-message/path associations.', `Counts associations between conflict messages and this path, rather than distinct conflicting merges. Multiple messages in one merge may yield multiple associations. Only mapped paths also present in the merge's recorded changes contribute. ${gitScope}`, 'Two messages associated with a file in one merge give 2 path associations.');
add('git_merge_conflict_paths', 'conflict_position', 'Sum of linked conflict-message positions.', `Sums the zero-based positions of conflict messages linked to the file. This is an identifier/order detail, not a conflict count. ${gitScope}`, 'Associations to message positions 1 and 3 give 4.');

for (const [metric, target] of Object.entries({
  'code.function_count': 'code_functions.count',
  'code.call_count': 'code_calls.count',
  'git.change_count': 'git_file_changes.count',
  'git.conflict_count': 'git_merge_conflict_files.count',
})) {
  const original = entries.find(entry => entry.metric === target);
  entries.push({ ...original, metric, long: `Alias of ${target}. Both names return the same value. ${original.long}` });
}

export const metricHelp = entries;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function metricHelpHtml(metrics = []) {
  const catalog = new Map(entries.map(entry => [entry.metric, entry]));
  for (const entry of metrics) if (!catalog.has(entry.metric)) {
    const [table, field] = entry.metric.split('.');
    catalog.set(entry.metric, { metric: entry.metric, short: entry.description || 'Numeric metric supplied by this inspection.',
      long: `This inspection exposes an additional metric. The treemap sums ${field} from ${table} per file. Detailed field semantics are not documented by this version of Help. Check the schema of the inspection that supplied it.`,
      example: 'Two associated rows with values 2 and 3 give a file value of 5. This arithmetic does not define what the field measures.' });
  }
  const groups = [
    ['Common metric aliases', entry => /^(code|git)\./.test(entry.metric)],
    ['Code metrics', entry => entry.metric.startsWith('code_')],
    ['Git metrics', entry => entry.metric.startsWith('git_')],
    ['Additional inspection metrics', entry => !/^(code|git)[_.]/.test(entry.metric)],
  ];
  return `<div class="metric-help"><div class="help-toolbar"><h1>Help</h1>
    <label class="help-search" for="metric-help-search">Search metrics<input id="metric-help-search" type="search" placeholder="Name, description or example" aria-controls="metric-help-list"></label><span id="metric-help-count" class="hint" role="status">${catalog.size} metrics</span></div>
    <details class="metric-guide"><summary>How metrics become a treemap</summary>
    <p>Every metric is aggregated per file. Numeric fields are <strong>summed</strong>, including flags, positions and function nesting maxima. A <code>.count</code> metric counts associated rows. No associated rows gives 0; missing numeric values contribute 0 and may produce a warning. Source counts describe static occurrences, not runtime frequency.</p>
    <p>The rectangle area uses the raw file metric. Files with area 0 or less are omitted. Each score term contributes <code>max(0, min(value, Maximum) - Minimum) × Weight</code>. Blank Minimum means 0, blank Maximum means no cap and blank Weight means 1. Contributions within a group are added; group scores are multiplied to determine heat.</p>
    <p>Example: value 12, Minimum 2, Maximum 10 and Weight 0.5 contribute 4. If another term contributes 2, the group score is 6. Multiplying by a second group score of 3 gives heat 18. Heat thresholds map that result to green, yellow, red and violet; they do not change the metric values.</p>
    <p>Code metrics describe the inspected source snapshot. Git metrics describe imported history on the inspected branch, subject to the commit limit and date filters. Only files in the code inspection appear. Availability depends on the saved inspection schema; this reference also works before the first inspection.</p></details>
    <div id="metric-help-list">${groups.map(([title, matches]) => {
      const group = [...catalog.values()].filter(matches).sort((a, b) => a.metric.localeCompare(b.metric));
      return group.length ? `<section class="metric-help-group"><h2>${title}</h2><div class="metric-help-entries">${group.map(entry => `<details class="metric-help-entry"><summary><span class="metric-help-summary"><code>${esc(entry.metric)}</code><span>${esc(entry.short)}</span></span></summary><dl><div><dt>Calculation</dt><dd>${esc(entry.long)}</dd></div><div><dt>Example</dt><dd><pre>${esc(entry.example)}</pre></dd></div></dl></details>`).join('')}</div></section>` : '';
    }).join('')}</div><p id="metric-help-empty" hidden>No matching metrics. Try a metric name such as complexity or git.change_count.</p></div>`;
}

export function filterMetricHelp(view, query) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  let visible = 0;
  for (const entry of view.querySelectorAll('.metric-help-entry')) {
    const content = entry.textContent.toLowerCase();
    entry.hidden = !words.every(word => content.includes(word));
    if (!entry.hidden) visible++;
  }
  for (const group of view.querySelectorAll('.metric-help-group')) group.hidden = !group.querySelector('.metric-help-entry:not([hidden])');
  view.querySelector('#metric-help-count').textContent = `${visible} metrics`;
  view.querySelector('#metric-help-empty').hidden = visible !== 0;
}
