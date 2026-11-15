# Local Code View server

Start from the repository root:

```sh
npm ci --prefix src/code-inspector/typescript
npm ci --prefix src/treemap
npm ci --prefix src/score-code
npm start --prefix src/server
```

Open http://127.0.0.1:3210. The server uses the inspector, score-code and treemap packages. It needs no
separate installation in the server directory. Requires Node >=22.13, Python >=3.10, and Git >=2.38
on PATH. Use `git --version` to check the Git binary that the server will run.

The four navigation entries provide:

- Inspection configuration: named local repositories, relative tsconfig paths,
  code include/exclude patterns, and an optional commit limit. Empty means all
  reachable history. Choose a repository root with a checked-out branch.
  Author identities combine a person's primary and additional email addresses
  across all presets for that repository. Identity changes apply to saved results
  without another inspection. Emails are trimmed and matched case-insensitively;
  overlapping identities are rejected. Names alone never combine different emails.
- Treemap: independent inspection and global treemap preset selectors, independent Code/Git starts and Run both, progress/output, targeted cancellation, and an expandable warnings section.
  Both inspectors can run concurrently and have their own status, output and progress bar with exact processed/total counts. One run per inspector/configuration is allowed at a time.
  Code preparation also reports dependency fingerprint and symbol indexing activity
  before the completed-file counter begins.
  A compact panel remains visible on every page, even for another selected
  configuration. Preparing/finalizing phases have an indeterminate indicator.
  Counts remain visible after success, failure, or cancellation until the next run
  or server restart. Progress refreshes every 1.5 seconds without replacing forms
  or closing the inspection output panel.
- Score configuration: independent, named JavaScript function and file contributions,
  with a per-function-field file aggregation (`sum(scores)` by default). CodeMirror
  supplies scope-specific completion and TypeScript diagnostics for metric/Lodash
  typos. Contribution names default to the first metric and can be edited. Syntax
  errors require confirmation before saving; invalid contributions and dependent
  totals become null with an error hint.
- Filters: reusable repository-relative path patterns and inclusive Git date bounds.
  The selected score and filter define the same calculation in every view.
- Treemap settings: separate named area metrics and heat scales. Presentation
  changes reuse persisted scores. Legend edits remain temporary until explicitly
  copied to the selected treemap settings and saved.
- Help: separate function metrics, file code metrics and file Git metrics, with
  JavaScript examples, input types, common Lodash tools and execution rules.

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
inspection. Each inspector writes only its own tables into its own staging file and publishes
its successful result independently. Code never reads or writes Git tables, and
Git never reads or writes Code tables. Run both starts them in parallel. Failure
or targeted cancellation preserves that inspector's last successful result and
does not stop the other inspector. Configurations remain editable during runs;
each run uses its saved start configuration. Deleting a running configuration is
blocked until its runs finish or are cancelled.

Code results become usable immediately without Git. Missing Git metrics are null
inputs to score formulas and history/author displays are unavailable. Git results
alone show status and completion time until Code provides the view's file population.
The view combines the latest successful results from the same repository and shows
separate timestamps, commits and configuration freshness; differing commits or an
inspected dirty working tree produce a mixed-state notice. Source warnings use
the Code result's own commit, independently of Git inspection.

Changes to tsconfig/include/exclude mark only Code stale; a commit-limit change
marks only Git stale. Score definitions, reusable path/date filters, display
settings and author identities apply to existing measurements without reinspection.
A repository switch retires both result associations, including in-flight results
from the prior association. Saving never starts an inspection automatically.
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

Inspector results are immutable `code-<generation>.sqlite` and
`git-<generation>.sqlite` files. Consumers compose their tables into an
`analysis-<source-pair>.sqlite` snapshot; scores and named contributions are cached
in its `score_*` tables. A new result from either inspector selects a new pair and
invalidates scores; existing requests can finish against their original snapshot.
Snapshots are retained until the configuration is deleted. Existing combined
`analysis.sqlite` results remain readable and are independently superseded by new
runs without a migration script. The score module uses one reusable worker thread
inside the server process. Formulas compile once per calculation; no subprocesses
or per-function workers are created. Hanging fields become null after their time
budget and other fields continue. Run only trusted user code; workers are not a
security sandbox. Source measurements, author identities and inspection results
remain independent. Presets were transferred manually without migration scripts.
See [the score module](../score-code/README.md) and
[treemap usage](../treemap/USAGE.md).

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
sortable tables, within the selected path filter, independently of rectangle size.
The selected inspection and scoring preset are shared across views. Both lists
score the same selected file/function population; search and filters preserve
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
filtered scoring population as Files and Functions. Search and table sorting only
change the display. Selected path and Git date filters apply to scores and their
attribution. Existing author identities combine email aliases.

The right sidebar provides independent named developer presets (New, Duplicate,
Delete, Save & apply). Defaults are proportional attribution, weighted average,
no extra normalization, weighted line changes, no merges and created/deleted/changed
weights of 1/1/1. Other aggregations are sum, maximum, weighted median and
quantile of score contributions. The quantile uses normalized file score times
author share, with equal weight per attributed file and linear interpolation
(0 = minimum, 50 = median, 100 = maximum). Files with zero attribution or missing
scores are excluded. File scores can be divided by effective code lines or scaled to 0–100
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

The browser caches treemap, file/function lists, developer data, graph data and
item details in memory (up to 32 requests). Successful inspection or preset
changes invalidate cached data. The navbar's Reload button clears the data caches
and fetches the current view again. Display options, disabled authors and per
inspection/score/filter/treemap Heat thresholds are stored separately in localStorage and
survive Reload and browser refresh. Heat Apply/Auto changes are local to this
browser; they do not modify the saved server treemap preset. If browser storage is
unavailable, preferences still work for the current session.
