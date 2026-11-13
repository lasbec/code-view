# Local Code View server

Start from the repository root:

```sh
npm ci --prefix src/code-inspector/typescript
npm ci --prefix src/treemap
npm start --prefix src/server
```

Open http://127.0.0.1:3210. The server itself uses Node built-ins and needs no
additional npm installation. Requires Node >=22.13, Python >=3.10, and Git >=2.38
on PATH. Use `git --version` to check the Git binary that the server will run.

The four navigation entries provide:

- Inspection configuration: named local repositories, relative tsconfig paths,
  code include/exclude patterns, and an optional commit limit. Empty means all
  reachable history. Choose a repository root with a checked-out branch.
  Author identities combine a person's primary and additional email addresses
  across all presets for that repository. Identity changes apply to saved results
  without another inspection. Emails are trimmed and matched case-insensitively;
  overlapping identities are rejected. Names alone never combine different emails.
- Treemap: independent inspection and global treemap preset selectors, manual
  inspection, progress/output, cancellation, and an expandable warnings section.
  Both inspectors have their own progress bar with exact processed/total counts.
  Code preparation also reports dependency fingerprint and symbol indexing activity
  before the completed-file counter begins.
  A compact panel remains visible on every page, even for another selected
  configuration. Preparing/finalizing phases have an indeterminate indicator.
  Counts remain visible after success, failure, or cancellation until the next run
  or server restart. Progress refreshes every 1.5 seconds without replacing forms
  or closing the inspection output panel.
- Treemap configuration: named global presets with area metrics, one to three
  weighted score groups, heat thresholds, path filters and Git history dates.
  Metric selectors use a curated catalog with readable names and no duplicate
  aliases, source positions or diagnostic codes. Contributions apply thresholds
  before configurable file aggregation (including interpolated quantiles).
  Each group has an optional upper limit and a normalization checkbox (0–100).
  Groups combine using sum, quantile, minimum, maximum or product.
- Help: a searchable reference for all selectable catalog metrics,
  with compact rows showing each short description once. Calculation rules and
  examples expand side by side on desktop and stack on small screens. The
  general introduction is collapsed by default. Explains
  per-file aggregation, score weights and thresholds, source-analysis limits,
  and Git history scope. Available before the first inspection.

Code filters use paths relative to the tsconfig directory. Treemap filters use
paths relative to the repository root. Code inspection reads working-tree files,
including uncommitted changes; Git inspection reads current-branch history.
Repository dependencies must be installed for complete TypeScript resolution.
The server never checks out, clones, or fetches repositories.

The header’s Theme selector offers Light (default), Dark, Nord, Dracula and
Solarized. Themes apply immediately throughout the interface, including treemap
controls and details. Each theme has matching green, yellow, red and violet heat
colors shared by tiles, file borders and the legend; score thresholds stay the same. The choice
is stored in this browser’s localStorage, survives reloads and synchronizes across
open tabs. It is independent of inspection settings and treemap presets.

Configuration changes require Save. Selectors save immediately and persist across
restarts. Preset changes take effect on the next visit to the Treemap view without
inspection. New inspections build a separate database and publish it only after
both inspectors succeed. During reruns, errors, or cancellation, the previous
successful treemap remains available. Editing a running inspection is blocked.
Server restart retains results and configuration; an interrupted run is discarded
on the next run. Detached HEAD and unborn branches produce an inspection error.

Data defaults to `src/server/data/`, ignored by Git. Set `CODE_VIEW_DATA_DIR` to
choose a persistent directory; set `PORT` to change the default port 3210. These
are server settings, never form fields. The server binds only to 127.0.0.1.
Deleting an inspection configuration also deletes its results. Global presets
remain independent of inspection configurations.

```sh
npm test --prefix src/server
```

Tests exercise configuration validation, concurrent storage updates and restart,
real TypeScript/Git inspection, treemap generation, failed reruns, cancellation,
and cross-origin request rejection. Tests use temporary repositories and data.

On desktop, the Treemap view fits the available viewport height. The map grows
between the compact configuration bar and status footer; file details use a
horizontal grid. Expanded warnings and unusually large detail sets can scroll
within their panels. Small screens retain page scrolling for usable controls.
File details show separate top-two lists for authors of non-merge commits and
authors of merge commits, calculated from the existing SQLite data. Merge counts
include branch integrations and possible conflict resolutions; they do not prove
that the merge author edited the file. Existing Git score metrics still include
merges. No new inspection is needed for these lists or identity changes.

Treemap preset format version 2 deliberately discards older treemap presets on
first startup and creates a new default preset. Inspection configurations,
repository settings, author identities and existing result databases are preserved.
Run inspection again to refresh measurements affected by analyzer corrections;
changing aggregation, normalization or group operations needs no reinspection.
See [calculation rules and JSON configuration](../treemap/USAGE.md).

The treemap toolbar's **Show functions** checkbox temporarily subdivides files
into function tiles, with the file score shown on the surrounding border.
Choose **Function tile size** in the preset configuration. Function colors exclude
file-only metrics; group limits and the legend are shared with file scores.
The checkbox is never persisted. Older analyses require one new inspection to
record exclusive source sizes; existing file views continue to work.

## File and function inspection

Click a file or function in the treemap to open its compact inspection view.
Linked functions and files open their details; Back preserves the mounted treemap
and its zoom. Details retain the active preset and score normalization context,
including when following links outside the preset's path filters.

Views show score contributions, line composition, incoming usages, outgoing calls,
complexity, signatures/parameters or file exports/imports/history, and mutations.
Mutation rows identify the externally visible object, expression, certainty and
source line. Newly created local objects are excluded; aliases to parameters or
other external objects retain the original affected object's name.

Source previews read current repository files on demand, without snapshots.
A different HEAD or uncommitted changes produce a warning that metrics and source
locations may be stale. Missing files remain inspectable through stored metrics.
Source symlinks must resolve inside the configured repository. Open in editor uses
VS Code's file URL handler. Run inspection again to collect exact imports,
non-function symbol usages, exports and signatures from schema version 6.

## Files and Functions

The Files and Functions navigation entries show all inspected items in compact,
sortable tables, independently of treemap path filters or rectangle size.
The selected inspection and scoring preset are shared across views. Both lists
score the same complete file/function population; search and filters preserve
those scores. Opening a row preserves that scoring context in its detail view.
Back restores the list's searches, selected filters, sorting, page and scroll.

Functions has separate case-insensitive name/path and signature searches; both
searches must match. One multiselect combines kinds, visibility, static, async,
exported and generator traits with **OR**. With no selection all functions appear.
Selected chips can be removed individually or cleared together. Legacy inspection
results keep kind filtering and show a reinspection notice for missing traits.
Lists sort by descending score initially, keep unscored items last in both
sort directions, and display 100 rows per page. Counts cover all matching items.
Mutation columns count definite/possible static mutation occurrences, excluding
objects created locally in the function. File complexity sums function cyclomatic
complexity. Rows are fetched once per inspection-result/preset context; searches,
filters, pagination and sorting run locally without re-reading source files.

## Dependency graph

The **Graph** tab shows expandable cycle groups or coupling clusters, at file or
function level. The right sidebar manages named global grouping presets (New,
Duplicate, Delete, Save & apply). Presets and their selected dropdown entry survive
server restarts; they are independent of treemap scoring presets. Open groups,
zoom and search are temporary. Search highlights without recalculating groups.

Choose calls, function/symbol references, or file imports/reexports. References
include callback and export uses and do not imply direct calls. Imports currently
include type imports. Unknown/external targets cannot be followed; module-scope
uses are excluded from function graphs. Paths are relative to the tsconfig.
Include/exclude patterns change the graph before grouping, and can break cycles.

Cycle mode collapses strongly connected components. Direct function recursion is
optional; internal file self-edges are omitted. Coupling mode uses deterministic
multilevel modularity optimization, with resolution 0.1–5 (larger values prefer
smaller clusters), binary/count/logarithmic occurrence weights, and optional
direction. Large clusters may be subdivided within their parent, up to the chosen
depth, with increasingly fine resolution. Target size is a subdivision trigger,
not a hard size guarantee. Minimum collapse size affects presentation only.
Cycle outlines indicate membership in an original cycle component; they do not
claim every cluster subset is itself cyclic. File cycles do not prove recursion.

Click groups to open/close them; double-click elements to inspect source details.
Connection numbers count distinct directed element relationships, not execution
frequency. Select a connection for its source evidence. Up to 100 locations per
relationship and 300 per selection are shown. Use Fit, zoom buttons, mouse wheel
and background dragging to navigate. Calculations run in a worker with a timeout.

## Developers

The Developers tab attributes current file scores to Git authors, using the same
all-file scoring population as Files and Functions. Search, table sorting and
Treemap path filters do not change these scores. Git date bounds come from the
selected scoring preset. Existing author identities combine email aliases.

The right sidebar provides independent named developer presets (New, Duplicate,
Delete, Save & apply). Defaults are proportional attribution, weighted average,
no extra normalization, weighted line changes, no merges and created/deleted/changed
weights of 1/1/1. Other aggregations are sum, maximum, weighted median and weighted
quantile. File scores can be divided by effective code lines or scaled to 0–100
using the largest score across the inspection; zero-code-line files have no
per-line score. Winner attribution gives the whole file to its main author;
proportional attribution uses that author's fraction of commits or weighted line
changes. Ties resolve by identity email. Missing/zero weighted changes fall back
to commit shares and are marked. This describes contact with currently scored
files, not the quality impact of individual developers. Historical renames are
not followed. Merge contributions are diffs against the first parent.

Developer details show attributed file scores and individual commits. Created,
deleted and changed totals and averages per distinct commit remain unweighted;
only commits touching inspected current file paths count, including deletion-only
commits. Unknown categories remain unavailable rather than becoming zero.

New inspections use a Myers diff to separate local replacement blocks into
changed=min(added,removed), created=added-changed, deleted=removed-changed.
Whitespace and comments count. Existing Git added/deleted/churn fields retain
their original meanings; weighted contributions are separate. Old inspections
need a rerun for the new categories. See [algorithm research](../../docs/research/created-deleted-changed-lines.md).

Treemap's Color by selector switches between Score and Main author. Main authors
use the selected developer preset's basis, weights and merge policy. Function
subtiles inherit their file author's color; unknown authors are gray. Colors are
assigned in canonical identity order, and the categorical legend lists authors.

Treemap author legend buttons toggle individual authors to gray without changing
rectangle sizes. The author palette uses distinct saturated colors and adapts
label contrast. File and function details show proportional authorship from the
selected developer preset (independent of winner attribution); function shares
refer to the containing file. The URL parameter `treemapPath` preserves zoom
across settings changes and reloads, falling back to the closest visible ancestor.
