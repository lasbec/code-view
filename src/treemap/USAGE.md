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
  "area": "code_files.size_bytes",
  "scores": [
    {
      "name": "Complexity",
      "metrics": [
        { "metric": "code_functions.cyclomatic_complexity", "min": 10, "max": 100, "factor": 2 },
        { "metric": "code.function_count", "factor": 0.5 }
      ]
    },
    {
      "name": "Changes",
      "metrics": [{ "metric": "git.change_count", "min": 1 }]
    }
  ],
  "heat": { "min": 0, "max": 1000, "yellowFrom": 250, "redFrom": 700 }
}
```

Numeric metrics are summed per file **before** applying thresholds. Each term is
`max(0, min(value, max) - min) * factor`. Defaults: min 0, no maximum, factor 1.
Terms within a score are added; the one to three defined scores are multiplied.
A zero score makes the final score zero. Thresholds and factors are nonnegative;
a term's maximum must exceed its minimum. Each score needs at least one term.
`--list-metrics` lists available numeric columns and event counters. Counter aliases
include `code.function_count`, `code.call_count`, `git.change_count`, `git.conflict_count`.

Area defaults to `code_files.size_bytes`; rerun the updated Code Inspector to add
this field to older databases. Select any available metric for a different area.
Missing/NULL measurements count as zero. Files with nonpositive area are omitted.
Unknown metrics and invalid configurations are errors, not zero-valued metrics.

Colors interpolate linearly: green at heat min, yellow at yellowFrom, red at
redFrom, violet at heat max. Values outside the range retain the endpoint color.
Defaults: min 0, max the largest filtered score, yellow/red at one/two thirds.
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
following historical renames are not supported.

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
