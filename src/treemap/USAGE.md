# Treemap

Render interactive HTML from an inspection SQLite database. Scoring is owned by
[`../score-code`](../score-code/README.md); treemap settings control only area and
heat presentation. Install both packages:

```sh
npm ci --prefix src/score-code
npm ci --prefix src/treemap
node src/treemap/src/cli.mjs --input analysis.sqlite --output report.html --config score-and-display.json
```

The CLI writes reusable score results to `score_*` tables in the input database
and creates `report.html` plus `report.warnings.html`. It never overwrites the
input with an HTML output. Use `--list-metrics` to inspect available source metrics.

A CLI configuration combines a score definition and display settings:

```json
{
  "fields": [
    {
      "id": "complexity",
      "kind": "function",
      "name": "Complexity",
      "code": "metrics.cyclomatic_complexity",
      "aggregation": "sum(scores)"
    }
  ],
  "area": "code_files.effective_lines",
  "functionArea": "code_functions.exclusive_size_bytes",
  "heat": {}
}
```

Use repeatable `--include GLOB` / `--exclude GLOB` for repository-relative paths,
`--since ISO_DATE` / `--until ISO_DATE` for inclusive Git commit-time bounds,
`--repository PATH_OR_ID` and `--code-prefix PATH` for ambiguous data sources,
and `--show-functions` to subdivide file tiles. `--author-identities identities.json`
combines author email aliases. Git date bounds do not change the source snapshot.

The server stores score, filter and treemap configurations independently. Every
view shares its selected score/filter context; changing heat or tile size reuses
the persisted scores. Heat settings accept `min`, `yellowFrom`, `redFrom` and `max`,
including negative values. Leave them blank for automatic bounds from the current
population. Colors interpolate green, yellow, red and violet; failed/null scores
stay neutral and visible. Nonpositive area is omitted from the map, while list
views retain those items.

Function tiles use their own scores; the surrounding file border retains the
file score. Exclusive function sizes partition the file area, reserving neutral
space for code outside functions. Older inspection results may need a rerun for
exclusive sizes and newly introduced metrics.

Legend Apply/Auto changes are temporary browser preferences. To save them, open
Treemap settings, choose **Use current legend values**, then **Save & apply**.
The theme and author-color options are separate view preferences. Clicking a tile
opens source details and named score contributions. Git metrics summarize imported
history without following renames; reconstructed conflicts are not proof of
historical resolution or individual quality.

The programmatic Node interface exports `calculateTreeMap(bytes, config, options)`,
`renderTreeMap(model)` and `createTreeMap(bytes, config, options)`. The calculation
can accept an existing `options.scoreData` from the score module to reuse stored
results. Standalone HTML snippets embed only the interactive renderer; user scoring
code always executes server-side. Browser builds expose rendering only.

```sh
npm test --prefix src/treemap
npm run build --prefix src/treemap
```
