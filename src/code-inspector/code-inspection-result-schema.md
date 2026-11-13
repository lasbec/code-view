# Code inspection result schema

SQLite, schema version `6`. See [TypeScript usage](typescript/usage.md).

## Conventions

| Property | Meaning |
| --- | --- |
| `TEXT`, `INTEGER` | SQLite column types; flags are `INTEGER` values `0` or `1`. |
| `PK`, `FK` | Primary key, foreign key. |
| `NULL` | No value, no enclosing function or no resolved target. |
| File paths | Relative to the main tsconfig, using `/`; metadata configuration paths are absolute. |
| `line`, `column`, `end_line` | 1-based; end line inclusive. Columns count UTF-16 code units. |
| Node ID | `<file-path>:<0-based UTF-16 start offset>`; edits can shift IDs. |
| Counts | Static source occurrences, not runtime frequencies. |

## `code_files`

One row per selected source file.

| Field | Type | Content |
| --- | --- | --- |
| `id` | TEXT PK | Relative file path. |
| `size_bytes` | INTEGER | File size in bytes on disk. |
| `outside_size_bytes` | INTEGER | File bytes outside top-level implemented function spans, including comments, whitespace and any BOM. |
| `total_lines` | INTEGER | All lines; a trailing newline adds no extra line. |
| `blank_lines` | INTEGER | Lines without code or comment text. |
| `comment_lines` | INTEGER | Comment-only lines. |
| `lines_with_comments` | INTEGER | Lines with comments, including mixed code/comment lines. |
| `effective_lines` | INTEGER | Lines containing code. |
| `import_statements` | INTEGER | Static import statements, including `import =`. |
| `imported_bindings` | INTEGER | Imported names; default and namespace imports each count once. |
| `dynamic_imports` | INTEGER | `import()` call sites. |
| `reexports` | INTEGER | Export declarations with a module source. |
| `exported_variables` | INTEGER | Distinct exported variable declarations at module scope in this file. |

## `code_functions`

One row per function with an implementation; overload signatures without a body are excluded.

| Field | Type | Content |
| --- | --- | --- |
| `id` | TEXT PK | Function node ID. |
| `file_id` | TEXT FK | File → `code_files.id`. |
| `source_size_bytes` | INTEGER | UTF-8 bytes in the function span, including nested functions. |
| `exclusive_size_bytes` | INTEGER | Function span bytes minus directly nested function spans. |
| `exclusive_effective_lines` | INTEGER | Code lines with tokens outside nested function spans; functions may share a physical line. |
| `parent_function_id` | TEXT FK | Immediately enclosing function → `code_functions.id`; otherwise `NULL`. |
| `name` | TEXT | Function name, inferred variable name or `<anonymous@line:column>`. |
| `kind` | TEXT | TypeScript SyntaxKind, listed below. |
| `line` | INTEGER | Function start line. |
| `column` | INTEGER | Function start column. |
| `end_line` | INTEGER | Function's last line. |
| `total_lines` | INTEGER | Line span, including nested functions. |
| `blank_lines` | INTEGER | Blank lines within this span. |
| `comment_lines` | INTEGER | Comment-only lines within this span. |
| `lines_with_comments` | INTEGER | All lines with comment text within this span. |
| `effective_lines` | INTEGER | Code lines within this span. |
| `max_nesting` | INTEGER | Maximum simultaneous control-structure nesting. |
| `cyclomatic_complexity` | INTEGER | Base 1 plus branch counts from the metrics table. |
| `cognitive_complexity` | INTEGER | Weighted control structures from the metrics table. |
| `termination` | TEXT | `terminates` or `unknown` in the structural model. |
| `termination_reason` | TEXT | Explanation of the termination assessment. |
| `termination_candidate` | INTEGER | No locally detected termination obstacles, before call-graph evaluation. |
| `shadowing_count` | INTEGER | Assigned shadowing declarations from `code_shadowing`. |

| `kind` | Function |
| --- | --- |
| `FunctionDeclaration` | Function declaration. |
| `FunctionExpression` | Function expression. |
| `ArrowFunction` | Arrow function. |
| `MethodDeclaration` | Method. |
| `Constructor` | Constructor. |
| `GetAccessor`, `SetAccessor` | Getter, setter. |

## `code_parameters`

| Field | Type | Content |
| --- | --- | --- |
| `id` | TEXT PK | `<function-id>/p<position>`. |
| `function_id` | TEXT FK | Owning function → `code_functions.id`. |
| `position` | INTEGER | Parameter position, starting at 0. |
| `name` | TEXT | Parameter name or destructuring pattern as source text. |
| `type` | TEXT | Type emitted by the TypeScript type checker. |
| `optional` | INTEGER | `1` for `?` or a default value. |
| `rest` | INTEGER | `1` for a rest parameter. |
| `mutation_count` | INTEGER | Definite mutation sites affecting the passed object. |
| `possible_mutation_count` | INTEGER | Possible mutation sites affecting the passed object. |

## `code_accesses`

One row per recorded external-state access or parameter-object mutation.

| Field | Type | Content |
| --- | --- | --- |
| `id` | INTEGER PK | Access ID within the current result set. |
| `function_id` | TEXT FK | Accessing function → `code_functions.id`. |
| `scope` | TEXT | `outer_function`, `module`, `global`, `class_field` or `parameter`. |
| `symbol_name` | TEXT | Root symbol name, falling back to `this`. |
| `symbol_declaration` | TEXT | Declaration node ID; `NULL` if unknown. |
| `expression` | TEXT | Access expression as source text. |
| `parameter_id` | TEXT FK | Affected parameter → `code_parameters.id`; otherwise `NULL`. |
| `reads` | INTEGER | Read flag. |
| `writes` | INTEGER | Root-symbol reassignment flag. |
| `mutations` | INTEGER | Referenced-object mutation flag. |
| `effect` | TEXT | `definite` or `possible`, indicating effect certainty. |
| `line` | INTEGER | Access line. |
| `column` | INTEGER | Access column. |

## `code_calls`

| Field | Type | Content |
| --- | --- | --- |
| `id` | INTEGER PK | Call-site ID within the current result set. |
| `caller_id` | TEXT FK | Calling function → `code_functions.id`; `NULL` at module scope. |
| `file_id` | TEXT FK | Call-site file → `code_files.id`. |
| `target_id` | TEXT | Resolved function ID; `NULL` without a unique analyzed target. |
| `target_name` | TEXT | Called expression as source text. |
| `resolution` | TEXT | `resolved`, `ambiguous` or `unknown`. |
| `kind` | TEXT | `call` for a call, `construct` for `new`. |
| `line` | INTEGER | Call-site line. |
| `column` | INTEGER | Call-site column. |

## `code_function_references`

Function uses, including direct calls; import declarations alone are excluded.

| Field | Type | Content |
| --- | --- | --- |
| `id` | INTEGER PK | Reference ID within the current result set. |
| `function_id` | TEXT FK | Using function → `code_functions.id`; `NULL` at module scope. |
| `file_id` | TEXT FK | Usage file → `code_files.id`. |
| `target_id` | TEXT | Detected function ID; `NULL` outside the analyzed set. |
| `target_name` | TEXT | Usage expression as source text. |
| `kind` | TEXT | `direct_call`, `argument`, `assignment`, `return`, `export` or `other`. |
| `line` | INTEGER | Usage line. |
| `column` | INTEGER | Usage column. |

`target_id` in calls and references is intentionally not an FK; filters can exclude targets from the result.

## `code_shadowing`

One row per shadowing declaration, including parameters; names used only as types are excluded.

| Field | Type | Content |
| --- | --- | --- |
| `id` | INTEGER PK | Shadowing ID within the current result set. |
| `function_id` | TEXT FK | Enclosing function → `code_functions.id`. |
| `name` | TEXT | Newly declared name that shadows another symbol. |
| `line` | INTEGER | Declared name's line. |
| `column` | INTEGER | Declared name's column. |
| `hidden_symbol` | TEXT | Fully qualified name of the shadowed symbol. |
| `hidden_declaration` | TEXT | Node ID of its first declaration; `NULL` if unknown. |

## `code_diagnostics`

Semantic compiler diagnostics from loaded projects; may include files outside the CLI selection.

| Field | Type | Content |
| --- | --- | --- |
| `id` | INTEGER PK | Diagnostic ID within the current result set. |
| `file` | TEXT | Relative file path; `NULL` without a file. |
| `line` | INTEGER | Diagnostic line; `NULL` without a source position. |
| `code` | INTEGER | TypeScript diagnostic code. |
| `message` | TEXT | Compiler message; may contain multiple lines. |

## `code_file_state`

| Field | Type | Content |
| --- | --- | --- |
| `file_id` | TEXT PK, FK | File → `code_files.id`. |
| `fingerprint` | TEXT | SHA-256 over analyzer, configuration, options, sources and dependencies. |

Fingerprints are recalculated each run; previous analysis results are not reused.

## `code_metadata`

| Field | Type | Content |
| --- | --- | --- |
| `key` | TEXT PK | Metadata key from the following table. |
| `value` | TEXT | Corresponding value as text. |

| Key | Value |
| --- | --- |
| `schema_version` | `6`. |
| `analyzer_version` | `1.0.0`. |
| `typescript_version` | `5.9.3`. |
| `tsconfig` | Absolute path to the main tsconfig. |
| `updated_at` | Metadata write time as UTC ISO-8601 text. |
| `includes`, `excludes` | JSON arrays of CLI globs. |
| `configs` | JSON array of absolute paths to recursively loaded project configurations. |
| `termination_model` | Text identifying the conservative structural model. |

## Views

| View | Fields | Content |
| --- | --- | --- |
| `code_call_counts` | `caller_id`, `target_id`, `target_name`, `resolution`, `call_count` | Call sites per group. |
| `code_access_counts` | `function_id`, `scope`, `effect`, `reads`, `writes`, `mutations` | Summed access flags per group. |
| `code_file_function_counts` | `file_id`, `function_count` | Functions per file, including files with 0 functions. |

## Metrics and analysis limits

| Property | Rule |
| --- | --- |
| Line total | `total_lines = blank_lines + comment_lines + effective_lines`. |
| Nested functions | Included in line spans; control flow and events belong to the inner function. |
| Nesting | `if`, loops, `switch`, `catch`, ternary expressions; `else if` increases depth. |
| Cyclomatic | Base 1; +1 per `if`, loop, `catch`, ternary, non-default `case`, `&&`, `\|\|`, `??`. |
| Cognitive | `1 + depth` per control structure; +1 per logical operator, plain `else`, labeled `break`/`continue`. |
| Local metric | Cognitive complexity is not a complete Sonar implementation. |
| Accesses | Local variables and plain parameter reassignment excluded; `obj.a.b` is one root access. |
| Flags | `x++`: read + write; `obj.x++`: read + mutation. |
| Mutations | Tracks direct changes, simple `const` aliases and known Array/Map/Set mutators. |
| Possible effects | Unknown methods, object arguments and uncertain aliases may produce `possible`. |
| Alias limits | No complete path-sensitive heap analysis or effect analysis across multiple functions. |
| `terminates` | No detected obstacles; all direct targets also terminate in the model. |
| `unknown` | Loop, `await`, `yield`, property/element access, `throw`, `new`, tagged template or uncertain call. |
| Call graph | Recursive cycles and targets outside the analysis remain unknown. |
| Model limit | No formal runtime proof for proxies, implicit conversions or modified bindings. |
| Static targets | Symbol resolution and simple constant function aliases; dynamic dispatch remains uncertain. |

## Inspection detail metadata (schema version 6)

`code_functions.signature` stores the compiler-rendered signature. No source text is stored.
`code_imports` stores `file_id`, resolved `target_file_id` (nullable), `specifier`,
`kind` (`import`, `reexport`, `dynamic`), and 1-based `line`/`column`.
Targets outside inspected files remain descriptive external dependencies.
`code_exports` stores exported symbol names per file.
`code_symbol_references` records non-function cross-file runtime symbol usages with
owning function (nullable for module scope), source file, target file, expression
name, usage kind, and location. Function usages remain in `code_function_references`.
Re-run inspection to populate these tables in existing databases.
