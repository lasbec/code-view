# Treemap tool
Generate interactive HTML snippets from a SQLite database written by code-inspector
and optionally git-inspector. Requires Node.js >= 22.13.

## Install and run
Run these commands in `src/treemap`:

```sh
npm ci
node src/cli.mjs --input analysis.sqlite --output report.html --config scores.json
node src/cli.mjs --input analysis.sqlite --list-metrics
```

The output contains HTML fragments, not full pages:

- `report.html`: interactive treemap with navigation, legend and metric details.
- `report.warnings.html`: concise errors/warnings with expandable affected paths.

The warnings filename is derived from `--output`. Parent directories are created.
Exit status is 0 on success, including warnings, and 1 on errors. Calculation/input
errors produce both snippets when an output path is available and writable.

## Configuration
Pass a JSON file with `--config`, or JSON text with `--config-json`; choose one.

```json
{
  "area": "code_files.effective_lines",
  "operation": "sum",
  "scores": [
    {
      "name": "Complexity",
      "normalize": true,
      "max": 80,
      "metrics": [
        { "metric": "code_functions.cyclomatic_complexity", "min": 10, "aggregation": "sum", "factor": 2 },
        { "metric": "code_functions.max_nesting", "min": 3, "aggregation": "quantile", "quantile": 90 }
      ]
    },
    {
      "name": "Changes",
      "normalize": true,
      "metrics": [{ "metric": "git_file_changes.count" }]
    }
  ],
  "heat": { "min": 0, "max": 200, "yellowFrom": 60, "redFrom": 140 }
}
```

For each metric contribution, keep individual measurements **strictly above**
`min`, subtract `min`, aggregate the remaining excess values per file, then
multiply by `factor`. Defaults: threshold 0, weight 1, and the catalog's default
aggregation. No qualifying measurements gives 0. For example, function values
5, 10, 12 and 20 at threshold 10 contribute 2 and 10: sum 12, maximum 10,
count 2, median 6. Functions at or below the threshold do not enter quantiles.

Numeric contributions support `sum`, `min`, `max`, `quantile` and `count`.
Event counters support `count`: every associated row is a measurement of 1;
threshold 0 counts every event. The quantile parameter is 0–100 (default 50).
Quantiles use linear interpolation at index `(n - 1) * quantile / 100` in sorted
values. Thus 0 is minimum, 50 median and 100 maximum.

`Incoming references` (`code_function_references.incoming_count`) counts reference
sites targeting a function, matching its detail view's Incoming references count.
At file level it counts references to all functions defined in that file.
Repeated uses and self-references count separately; unresolved targets are excluded.
References from inspected files outside the visible path filters still count.
Use aggregation `count` and threshold 0. This metric is also available for function
tile sizing and works with existing inspections containing function references.
`Function references` (`code_function_references.count`) continues to count uses
at their source instead.

`Code churn` (`git_file_changes.churn`) measures the intensity of file changes:
added plus deleted lines, summed over imported changes. Choose aggregation `sum`
and threshold 0 for total churn; replacing one line contributes 2. Repository and
date filters apply as for Git file changes. Merge changes compare against their
first parent; root commits include initial lines. Binary or not yet backfilled
changes have missing values and produce warnings. Run the Git inspector again to
populate this metric in existing results. It is available for file scores and
file sizing; Git history is not attributed to individual functions.

Weighted contributions are added within each group. Each group is capped at
its `max`, even when normalization is disabled. A blank/omitted `max` uses the
largest raw group score among displayed files. Explicit group maxima must be
positive. `normalize` defaults to true: divide the capped score by the group
maximum and multiply by 100. A zero automatic maximum produces 0.

Combine the one to three groups using `operation`: `sum` (default), `quantile`,
`min`, `max` or `product`. Group quantiles use the top-level `quantile` parameter
(0–100, default 50) and the same interpolation. There is no final normalization:
two normalized groups can sum to 200 or multiply to 10,000. All-zero groups
remain zero; a zero group makes a product zero.

`--list-metrics` exposes an explicit catalog with readable labels, descriptions,
allowed aggregations and defaults. Identifiers, source positions, diagnostic
codes, duplicate views and legacy aliases are not selectable metrics.
Function nesting defaults to maximum; function complexity defaults to sum.
Function line spans include nested functions, so summing them may count lines
repeatedly. Cognitive complexity uses the analyzer's local rule.

Area defaults to `code_files.size_bytes`; the server's new default preset uses
`code_files.effective_lines`. Area uses the catalog's default file aggregation
without score thresholds. Files with nonpositive area are omitted **before**
automatic group maxima and legend calculation. Missing/NULL numeric measurements
are excluded from score aggregation and generate warnings; an empty aggregate
is 0. Unknown/unavailable metrics and invalid configurations are errors.

Colors interpolate linearly: green at heat min, yellow at yellowFrom, red at
redFrom, violet at heat max. Values outside the range retain the endpoint color.
Defaults: min 0, max the largest displayed final score, yellow/red at one/two thirds.
Require `min < yellowFrom < redFrom < max`; an all-zero default scale is green.
The scale stays fixed while navigating directories.

## Filters and path mapping

Repeat `--include 'src/**/*.ts'` and `--exclude '**/*.test.ts'` as needed.
Patterns match normalized repository-relative paths, including dotfiles.
Filtering happens before automatic legend calculation. Current Code Inspector
files define the file set; historical Git-only paths are excluded.

Code paths are relative to the tsconfig; Git paths are relative to the repository.
The tool derives their mapping from database metadata. For ambiguous or moved
projects, use `--repository PATH_OR_ID` and `--code-prefix packages/app`.
Git counters use all stored commits for that repository; optional `--since` and
`--until` ISO timestamps filter commit time inclusively. Branch filtering and
following historical renames are not supported. Reconstructed conflicts are mapped
directly from conflict paths, even when resolution leaves the file unchanged
against the first parent.

## JavaScript and browser API

```js
import { calculateTreeMap, renderTreeMap, createTreeMap } from './src/index.mjs';
const result = await calculateTreeMap(sqliteBytes, config, {
  include: ['src/**/*.ts'], exclude: ['**/*.test.ts']
});
const { treeMapHtml, treeMapWarningsHtml } = renderTreeMap(result);
// Shortcut: await createTreeMap(sqliteBytes, config, options)
```

Input is a `Uint8Array` or `ArrayBuffer`, never a filesystem path. Options also
accept `repository`, `codePrefix`, `since`, `until`, `authorIdentities`. Results contain `ok`, files,
hierarchy, legend and structured diagnostics. CLI and API use the same functions
and produce identical snippets. `listMetrics(bytes, options)` lists metrics.

Run `npm run build` and import `dist/treemap.js` in a browser. The bundle includes
SQLite; generated snippets embed their data and renderer and need no downloads.
Insert snippets through HTML parsing that executes their inline script, for
example server-rendered markup. Assigning `innerHTML` alone does not execute it.
Multiple snippets can coexist; each treemap isolates its styles in a shadow root.

File details show two separate rankings for the current file path: `topAuthors`
contains the two authors with the most distinct non-merge commits, with `commits`
counts; `topMergeAuthors` contains the two authors with the most distinct merge
commits, with `merges` counts. Merges include branch integrations and possible
conflict resolutions, so a merge count does not prove an author edited the file.
Existing Git score metrics continue to include merges.

Identity uses trimmed, case-insensitive email addresses. Name variants for the
same email are combined and a deterministic name is displayed. To combine known
email aliases, provide `authorIdentities` in the JavaScript options:

```js
const options = { authorIdentities: [
  { name: 'Alice Example', email: 'alice@work.test', aliases: ['alice@private.test'] }
] };
```

For the CLI, save the array to a JSON file and pass `--author-identities identities.json`.
Aliases apply before ranking; overlapping mappings are errors. Matching names
alone never combine different email addresses. The local server stores identities
in the repository's inspection configuration and applies them across its presets.

Both rankings use the selected repository and the same since/until filters as Git
metrics. Equal counts are ordered by email. Counts cover stored history, do not
follow historical renames, and do not represent line ownership. Older databases
without author columns show an unavailable-data message. No reinspection is
needed. A clicked file stays selected while moving the pointer; click another file
to change it.

## Function view

Pass `{ showFunctions: true }` in API options or `--show-functions` to the CLI.
The server has a transient **Show functions** checkbox above the map; it resets
on page reload and is not stored in presets. The preset's `functionArea` selects
a function-level size metric (default `code_functions.exclusive_size_bytes`).
File-only metrics cannot be selected for function size.

Files retain their configured total area and become containers with colored
borders showing their file score. Each function, including nested callbacks and
methods, is a direct child tile labelled with its name and source location.
An **Outside functions** tile reserves the proportion of source bytes outside
functions. Remaining area is distributed by the selected raw function size
metric, without score thresholds. Zero weights receive a small minimum; if all
weights are zero, exclusive source sizes supply the proportions instead.
The minimum weight is 0.5% of the largest weight divided by function count.
A file without functions consists entirely of the neutral outside tile.

Function scoring applies the same thresholds, file aggregation operations and
weights to measurements owned by that function. File-only metrics are excluded.
Empty scoregroups are omitted from function combination; a function with no
applicable groups has a neutral fill and no score. Details show raw values and
thresholded contributions. No file history is attributed to individual functions.
Automatic group maxima and the legend are shared by visible files and functions;
explicit limits still take precedence. Outside tiles do not enter scoring.

Function view requires inspector schema 5. Older results remain usable in file
view and request a new inspection when function subdivision is enabled. Source
byte measurements are exclusive, so nested function spans are never counted
again in the containing function. Exclusive code-line measurements can overlap
on physical lines containing more than one function.
