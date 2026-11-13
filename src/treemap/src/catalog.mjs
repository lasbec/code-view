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
count('code_diagnostics', 'Compiler diagnostics', 'Semantic diagnostics associated with inspected files; not runtime failures.');
count('git_file_changes', 'Git file changes', 'File-change events, including merge diffs against the first parent. Renames are not followed.');
add('git_commits', 'is_merge', 'Merge integrations', 'Merge commits changing this path against the first parent; not proof of editing or conflict resolution.');
count('git_merge_conflict_files', 'Reconstructed conflicting merges', 'Reconstructed merges reporting unresolved stages for this path; not proof of historical conflicts.');
count('git_merge_conflicts', 'Reconstructed conflict messages', 'Structured conflict messages associated with this path; several can occur in one merge.');
export const metricCatalog = entries;
export const metricById = new Map(entries.map(entry => [entry.metric, entry]));

export const functionMetrics = new Set(entries.filter(entry => ['code_functions', 'code_parameters', 'code_accesses', 'code_calls', 'code_function_references'].includes(entry.metric.split('.')[0])).map(entry => entry.metric));
export const functionSizeMetrics = entries.filter(entry => functionMetrics.has(entry.metric));
