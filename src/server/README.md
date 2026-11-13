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

The three navigation entries provide:

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
  Metric fields offer suggestions from the last displayed database and also
  accept metric names supported by the existing treemap API.

Code filters use paths relative to the tsconfig directory. Treemap filters use
paths relative to the repository root. Code inspection reads working-tree files,
including uncommitted changes; Git inspection reads current-branch history.
Repository dependencies must be installed for complete TypeScript resolution.
The server never checks out, clones, or fetches repositories.

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
