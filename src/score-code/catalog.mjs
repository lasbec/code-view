// Explicit public metrics. Database positions, identifiers and duplicate summary views
// are intentionally absent. IDs are stable; labels are for people.
const entries = [];
const add = (table, field, label, description, options = {}) => entries.push({
  metric: `${table}.${field}`, label, description, aggregation: 'sum',
  aggregations: ['sum', 'max', 'min', 'quantile', 'count'], ...options,
});
const count = (table, label, description) => add(table, 'count', label, description, { aggregation: 'count', aggregations: ['count'], counter: true });
for (const [field, label, description] of [
  ['size_bytes', 'File size (bytes)', 'Source file size on disk in bytes.'],
  ['total_lines', 'File lines', 'All source lines, including blank and comment-only lines.'],
  ['effective_lines', 'Code lines', 'Lines containing code tokens.'],
  ['blank_lines', 'Blank lines', 'Lines without code or comment text.'],
  ['comment_lines', 'Comment-only lines', 'Lines with comment text and no code.'],
  ['lines_with_comments', 'Lines containing comments', 'Includes comments alongside code.'],
  ['import_statements', 'Static imports', 'Static import declarations, including side-effect imports.'],
  ['imported_bindings', 'Imported names', 'Default and namespace imports each count once.'],
  ['dynamic_imports', 'Dynamic imports', 'Static occurrences of import().'],
  ['reexports', 'Re-exports', 'Export declarations with a module source.'],
  ['exported_variables', 'Exported variables', 'Distinct exported variable declarations in this file.'],
]) add('code_files', field, label, description);
add('code_functions', 'exclusive_size_bytes', 'Function source size (exclusive bytes)', 'UTF-8 source size excluding nested function spans.');
add('code_functions', 'exclusive_effective_lines', 'Function code lines (exclusive)', 'Code lines containing tokens outside nested functions; shared physical lines can belong to several functions.');
count('code_functions', 'Functions', 'Functions with implementations, including nested functions and methods.');
for (const [field, label, description, aggregation] of [
  ['total_lines', 'Function length (lines)', 'Function span including nested functions; sums can count lines repeatedly.', 'max'],
  ['effective_lines', 'Function code lines', 'Code lines within each function, including nested functions.', 'max'],
  ['max_nesting', 'Control-flow nesting', 'Maximum simultaneous control-structure depth; else-if currently increases depth.', 'max'],
  ['cyclomatic_complexity', 'Cyclomatic complexity', 'One plus recognized branches per function.', 'sum'],
  ['cognitive_complexity', 'Cognitive complexity (local rule)', 'Nesting-weighted control flow; not the complete Sonar definition.', 'sum'],
  ['shadowing_count', 'Shadowing declarations', 'Declarations hiding an enclosing value symbol.', 'sum'],
]) add('code_functions', field, label, description, { aggregation });
count('code_parameters', 'Parameters', 'Declared parameters; a destructuring pattern counts as one.');
for (const [field, label, description] of [
  ['optional', 'Optional parameters', 'Optional or defaulted parameter flags.'],
  ['rest', 'Rest parameters', 'Parameters declared with ... .'],
  ['mutation_count', 'Definite parameter mutations', 'Recognized mutation sites affecting passed objects.'],
  ['possible_mutation_count', 'Possible parameter mutations', 'Uncertain effects on passed objects; not confirmed changes.'],
]) add('code_parameters', field, label, description);
count('code_accesses', 'State-access events', 'External-state accesses and parameter-object mutation events; one event may carry several flags.');
for (const [field, label, description] of [
  ['reads', 'State reads', 'Recorded read flags, including reads accompanying mutations.'],
  ['writes', 'State reassignments', 'Reassignments of external root symbols.'],
  ['mutations', 'Object mutations (definite and possible)', 'Recorded object changes, including uncertain effects.'],
]) add('code_accesses', field, label, description);
count('code_calls', 'Call sites', 'Calls and constructor sites, including module scope and unresolved calls.');
count('code_function_references', 'Function references', 'Recorded function uses, including calls, arguments, assignments and returns.');
add('code_function_references', 'incoming_count', 'Incoming references', 'Reference sites targeting this function, or functions in this file, including calls, arguments, assignments and returns. Counts occurrences, including self-references; unresolved targets are excluded.', { aggregation: 'count', aggregations: ['count'], counter: true });
count('code_diagnostics', 'Compiler diagnostics', 'Semantic diagnostics associated with inspected files; not runtime failures.');
count('git_file_changes', 'Git file changes', 'File-change events, including merge diffs against the first parent. Renames are not followed.');
add('git_file_changes', 'churn', 'Code churn', 'Added plus deleted lines across imported file changes. Replacing a line counts twice. Includes root commits and merge diffs against the first parent; binary changes have no line count.');
add('git_commits', 'is_merge', 'Merge integrations', 'Merge commits changing this path against the first parent; not proof of editing or conflict resolution.');
count('git_merge_conflict_files', 'Reconstructed conflicting merges', 'Reconstructed merges reporting unresolved stages for this path; not proof of historical conflicts.');
count('git_merge_conflicts', 'Reconstructed conflict messages', 'Structured conflict messages associated with this path; several can occur in one merge.');

for (const [field, label, description] of [
  ['call_depth', 'Up +2 call depth (internal)', 'Longest internal call path including callback targets traced backwards through up to two argument bindings. Functions do not repeat; exact search has a state budget.'],
  ['reachable_internal_count', 'Reachable internal functions', 'Distinct reachable functions, including the starting function only if reached again.'],
  ['reachable_external_count', 'Reachable external symbols', 'Distinct external runtime functions and values referenced directly or by reachable internal functions.'],
  ['reachable_symbol_count', 'Reachable symbols total', 'Reachable internal functions plus external symbols.'],
  ['direct_external_count', 'Direct external symbols', 'Distinct external runtime symbols referenced in this function body.'],
]) {
  add('code_functions', field, label, `${description} Incomplete measurements are provided as null to formulas.`, { nullable: true, completenessField: ['call_depth', 'reachable_internal_count'].includes(field) ? 'call_graph_complete' : field === 'direct_external_count' ? 'direct_external_complete' : 'dependency_complete' });
}

add('code_functions', 'down_call_depth', 'Down call depth (internal)', 'Longest known internal call path following directly resolved calls, without callback backtracking. Includes incomplete graphs and retains a lower bound if the search budget is exhausted; zero means no deeper path has been established.');

for (const kind of ['internal', 'external']) {
  const description = `Function argument positions passed to ${kind} recipients in this function and recursively reachable internal callees and callbacks. Each reachable position counts once; packages and builtins are not traversed. File aggregation combines function values and can count shared sites repeatedly.`;
  add('code_functions', `function_argument_usage_${kind}`, `Function as argument usage (${kind})`, `${description} Incomplete measurements are provided as null to formulas.`, { nullable: true, completenessField: 'function_argument_usage_complete' });
  add('code_functions', `minimum_function_argument_usage_${kind}`, `Minimum function as argument usage (${kind})`, `${description} Includes known lower bounds from incomplete analysis in scores. When function_argument_usage_complete is zero, the value is a lower bound.`);
}

export const metricCatalog = entries;
export const metricById = new Map(entries.map(entry => [entry.metric, entry]));

export const functionMetrics = new Set(entries.filter(entry => ['code_functions', 'code_parameters', 'code_accesses', 'code_calls', 'code_function_references'].includes(entry.metric.split('.')[0])).map(entry => entry.metric));
export const functionSizeMetrics = entries.filter(entry => functionMetrics.has(entry.metric));

// Stable JavaScript names are unambiguous within their metric scope.
export const formulaMetrics = metricCatalog.map(entry => {
  const [table, field] = entry.metric.split('.');
  const scope = functionMetrics.has(entry.metric) ? 'function' : 'file';
  const scalar = table === 'code_functions' || table === 'code_files';
  return { ...entry, scope, category: scope === 'function' ? 'function' : table.startsWith('git_') ? 'git' : 'code',
    key: scalar ? field : `${table}_${field}`, type: scalar ? 'number | null' : 'Array<number | null> | null' };
});
