# Using the Git inspector

See the root [README](../../README.md) for requirements.

## Parameters

| Parameter | Required | Meaning |
| --- | --- | --- |
| `--repo` | yes | Local repository or subdirectory; bare repositories are supported. |
| `--branch` | yes | Local branch or remote-tracking branch, such as `origin/main`. |
| `--output` | yes | Path to a new or existing SQLite file; its directory must exist. |
| `--commits` | yes | Positive integer N; select at most N reachable commits. |
| `--mode` | yes | `append` adds missing commits; `replace` replaces all data for this repository. |
| `--help`, `-h` | no | Show help and exit. |

Relative paths use the working directory. Local branches take precedence over remote-tracking branches.
The branch is resolved once to a fixed commit hash, without a checkout.
Selection uses `git rev-list --topo-order --max-count=N`, including side branches and merges.
N is neither a time range nor the number of previously unknown commits.
If selection reaches a shallow boundary, the script aborts; provide the full history first.

## Example

From the repository root:

```bash
python3 src/git-inspector/git_inspector.py \
  --repo /path/project \
  --branch main \
  --output /path/results/analysis.sqlite \
  --commits 1000 \
  --mode append
```

## Result

The SQLite file contains commit metadata, file changes and reconstructed merge conflicts.
See the [result schema](git-inspection-result-schema.md) for tables, fields and relationships.
Commit messages, diffs and file contents are not stored.
The console reports selected and newly imported commits, new unknown merge analyses and the output path.

`append` does not recalculate existing commits or merge analyses.
The total may exceed N commits, including commits from multiple branches or rewritten history.
`replace` removes all data for the selected repository, including previous branch entries and merge analyses.
Use it to recalculate merge analyses after a Git update, for example.
Other repositories and unrelated tables are preserved; both inspectors can use the same SQLite file.
The repository key is its absolute, resolved root path; moving a repository creates a new identity.

The import uses one transaction; errors roll back changes.
A failed first import may leave an empty SQLite file.
The inspected repository's working tree, index, branches and object store remain unchanged.
Merge reconstruction uses temporary Git objects and does not prove historical conflicts or their resolution.
The Git version, attributes and merge configuration can affect the result.
Exit codes: `0` success or help, `1` runtime error, `2` invalid CLI arguments.

## Progress events

Optional `--progress` emits `CODE_VIEW_PROGRESS ` followed by one JSON object per
line on stderr. Normal CLI output is unchanged without this flag. Events contain
`status` (`preparing`, `processing`, `finalizing`), `completed` and `total`. The
total is null until known; counts describe processed files or selected commits,
not elapsed time. Intermediate updates are limited to approximately ten per
second; initial counts and finalization are always emitted. Finalization can
continue after the counter reaches its total. A successful process exit confirms
completion. The local server consumes these events separately from diagnostic logs.
