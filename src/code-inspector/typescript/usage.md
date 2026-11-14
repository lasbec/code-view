# Using the TypeScript code inspector

See the root [README](../../../README.md) for requirements and installation.

## Parameters

| Parameter | Required | Meaning |
| --- | --- | --- |
| `--tsconfig`, `-p` | yes | Path to the main tsconfig. |
| `--repository` | no | Repository root for internal/external classification; defaults to Git root, then tsconfig directory. |
| `--output`, `-o` | yes | Path to a new or existing SQLite file. |
| `--include` | no | Repeatable glob restricting the tsconfig file set. |
| `--exclude` | no | Repeatable glob removing files from the selection. |
| `--help`, `-h` | no | Show help and exit. |

Relative argument paths use the working directory.
Globs use the main tsconfig directory as their base; quote them in the shell.
Without filters, the entire tsconfig file set is selected, including tests.
Project references are loaded recursively; JavaScript is included when `allowJs` is enabled.
Declaration files and `node_modules` are excluded from result files.

## Example

From the repository root, after running `npm ci` in the script directory:

```bash
node src/code-inspector/typescript/src/main.mjs \
  --tsconfig /path/project/tsconfig.json \
  --output /path/results/analysis.sqlite \
  --include 'src/**/*.ts' --include 'src/**/*.tsx' \
  --exclude '**/*.test.ts'
```

Alternatively, in the script directory: `npm run inspect -- --tsconfig ... --output ...`.

## Result

The SQLite file contains file metrics, functions, parameters, accesses, calls and compiler diagnostics.
See the [result schema](../code-inspection-result-schema.md) for tables, fields, views and counting rules.
The console reports the numbers of analyzed files and functions and the absolute output path.
Semantic TypeScript diagnostics are stored and summarized on stderr.
Missing dependencies may reduce resolution accuracy; analyzed code is never executed.

Each run analyzes the entire selection and replaces all known `code_` tables, views and indexes.
Filters define the complete new result set; previous results outside the selection are removed.
Other database objects are preserved. Both inspectors can use the same SQLite file.
The rebuild uses one transaction; errors or interruption preserve previous results.
Syntax and configuration errors abort before writing.
An empty referenced project (TS18003) emits a warning and is recorded in
`code_diagnostics`; analysis continues for the remaining projects.
An empty main configuration and other configuration errors still abort.
Foreign-key violations anywhere in the database prevent the commit.
Other writers are blocked during writing; a failed first run may leave an empty file.
Exit code `0` means success or help; `1` means an error. Runs are neither continuous nor incremental.

## Progress events

Optional `--progress` emits `CODE_VIEW_PROGRESS ` followed by one JSON object per
line on stderr. Normal CLI output is unchanged without this flag. Events contain
`status` (`preparing`, `processing`, `finalizing`), `completed` and `total`. The
optional `detail` describes preparation activity such as fingerprinting or symbol
indexing. These preparatory counts are separate from completed files. The
total is null until known; counts describe processed files or selected commits,
not elapsed time. Intermediate updates are limited to approximately ten per
second; initial counts and finalization are always emitted. Finalization can
continue after the counter reaches its total. A successful process exit confirms
completion. The local server consumes these events separately from diagnostic logs.

## Dependency metrics and external symbols

Rerun inspection to populate internal call depth and direct/transitive dependency counts.
Cycles contribute to depth until a function would repeat. Reachable sets include the starting function when a call path returns to it. External functions and values count once; their implementations are not followed. Passing a function as an argument alone does not create an internal call edge.

Two internal depth metrics are selectable for scores:

- **Up +2 call depth (internal)** (`code_functions.call_depth`) follows known calls and callback targets traced backwards through up to two argument bindings. Incomplete call graphs and undetermined exact depths are excluded from its scores.
- **Down call depth (internal)** (`code_functions.down_call_depth`) follows the original directly resolved call graph without callback backtracking. Every function has a nonnegative value, including zero. Incomplete graphs remain usable; if exact search exhausts its budget, the metric retains a discovered lower bound. It replaces the temporary Minimum internal call depth metric.

Both metrics count edges without repeating a function. Each graph uses at most 1,000,000 search states per cycle component and 5,120 nested search steps. Searches stop when a path reaches the proven upper bound. If inference adds no call edges, both metrics reuse the same search. Rerun inspection to obtain the separate graphs and depth values; older databases cannot reconstruct the original Down graph after callback targets have been combined. Existing saved Minimum internal call depth presets migrate to Down call depth (internal).

Unresolved value references affect symbol counts but leave depth and internal reachability usable. Reachable internal functions still requires a complete call graph for scoring. Direct external counts depend only on references in the function body. The function list supports sorting by dependency metrics, and includes a searchable repository-wide external-symbol catalogue with aliases and source locations. Function details show reachable functions, external references and unresolved dependencies.

Callback calls through parameters are resolved backwards across at most two call sites (a direct argument binding and one forwarding function). Known targets are combined; unknown arguments, exported or escaped entry points, reassigned parameters, spreads, and longer forwarding chains remain incomplete. Resolution is cached and limited to 100,000 work steps per inspection and 256 targets per parameter query. Each inferred target creates a call edge at the original callback invocation; passing a function alone still creates no call edge. Callback inference does not strengthen termination proofs.

### Function as argument usage

The inspector records `function_argument_usage_internal` and
`function_argument_usage_external` on each function. Each function-valued
argument position at a call or constructor site counts once. The recipient
classifies the site as internal or external (packages, builtins, or sources
outside the repository). Anonymous callbacks and recognizable forwarded
function parameters are included.

Counts include the starting function and recursively reachable internal callees
and internal functions passed as arguments, even if a callback might never run.
Each reachable argument position counts once per starting function, including in
cycles or diamonds. External implementations are never traversed. Excluded
project code is unknown internal code, not external code.

Callback target inference uses the existing two-binding limit. Unresolved calls,
possibly function-valued arguments, spread arguments, missing internal bodies,
and incomplete callback resolution make `function_argument_usage_complete` zero.
Both exact fields are then NULL. The corresponding
`minimum_function_argument_usage_internal` and
`minimum_function_argument_usage_external` retain the known lower bounds and
remain usable in scores. Details show incomplete minima with ≥. File metrics
aggregate the function values using the selected sum, max, min, quantile or count;
summing can count shared reachable sites once for each starting function.
A new inspection is required to populate these columns in older databases.
