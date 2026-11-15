# Score code

Shared server-side JavaScript scoring for file/function lists, details, developer
attribution and the treemap. Requires Node >=22.13.

```sh
npm ci --prefix src/score-code
npm test --prefix src/score-code
node src/score-code/cli.mjs --input analysis.sqlite --score score.json --filter filter.json
```

A score definition contains independent, named fields:

```json
{
  "fields": [
    {
      "id": "complexity",
      "kind": "function",
      "name": "Complexity",
      "autoName": false,
      "code": "Math.max(0, metrics.cyclomatic_complexity - 10)",
      "aggregation": "sum(scores)"
    },
    {
      "id": "churn",
      "kind": "file",
      "name": "Churn",
      "code": "sum(metrics.git_file_changes_churn)"
    }
  ]
}
```

A filter is `{ "include": [], "exclude": [], "since": "2026-01-01T00:00:00Z" }`.
Paths are relative to the Git repository; dates inclusively filter imported Git
commits and never select a historical source snapshot. The CLI also accepts saved
preset wrappers (`config` for scores, `options` for filters).

Function metrics are separate from file code/Git metrics. `catalog.mjs` owns their
JavaScript keys, descriptions and types. Scalar inputs are numbers or null;
event inputs are arrays (or null when unavailable). Count arrays contain ones.
Missing measurement values inside collections remain null. Function scores sum
function fields; file scores sum each field's independent function aggregation
and the file fields. Files without functions pass `[]` to aggregations.

Expressions and function bodies with `return` are supported. Lodash is available
as `_` and through direct functions such as `sum`, `max`, `mean`, `map`, `sumBy`,
`clamp` and `round`. Aggregations receive only `scores`, never file/function metrics.
Results must be finite numbers; negative scores are allowed. Errors become null
with diagnostics and propagate into dependent totals without affecting other
entities. TypeScript checks JavaScript and provides metric/Lodash typo diagnostics.
Auto names use the first statically referenced metric, falling back to the field
kind when no metric is referenced. Manual names persist across code changes.

`createScoreWorker()` in `worker-client.mjs` serializes requests through one
reusable worker thread in the existing Node process. Send `{path, definition,
filter}`; use `{editor:true, code, scope}` for editor diagnostics and catalog data.
Call `close()` during shutdown. The server supplies a presentation adapter through
`serveScoreWorker()`, keeping its view preparation outside this module.

Formulas compile once per calculation and run directly for each entity, without
creating VMs, threads or processes per function. A field's execution phase has a
10-second budget. On timeout the worker is replaced and that field is retried as
null with a diagnostic, allowing the other fields to finish. This is trusted user
code: the VM context and worker are not a security sandbox. File, network and
module access are not provided; asynchronous formula results are rejected.

`ensureScores()` owns SQLite persistence. The inspection database contains:

- `score_runs`: content key, score definition, filter and completion time.
- `score_results`: file/function totals and errors per run.
- `score_contributions`: ordered, named field results and diagnostic details.

Each run is committed in one transaction. The content key includes the computation
version, definition and data filters. Heat and area settings are excluded. The server composes each successful Code/Git result pair into a separate consumer
database. A new result from either inspector changes that pair and invalidates
scores; inspector databases never contain score tables. The worker checks database generation before returning results. Existing
presets were transferred manually; there is no legacy migration path.
