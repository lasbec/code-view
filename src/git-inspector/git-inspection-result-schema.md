# Git inspection result schema

SQLite, schema version `2`. Version 1 is migrated automatically; line statistics
are backfilled for commits selected by subsequent imports. See [usage](usage.md).

## Conventions and relationships

| Property | Meaning |
| --- | --- |
| `PK`, `FK`, `?` | Primary key, foreign key, nullable; all other fields are NOT NULL. |
| Flags | `INTEGER` values `0` or `1`. |
| File paths | Relative to the repository root; UTF-8, potentially including tabs and newlines. |
| Timestamps | ISO 8601 with time zone, stored as `TEXT`. |
| `repository_id` | FK → `git_repositories.id`; internal key, not a CLI parameter. |
| Commit reference | `(repository_id, commit_hash)` → `git_commits(repository_id, hash)`. |
| Merge reference | `(repository_id, commit_hash)` → `git_merge_analysis`. |
| Deletion | All FKs use `ON DELETE CASCADE`. |

## `git_inspector_schema`

| Field | Type | Content |
| --- | --- | --- |
| `version` | INTEGER | Schema version; exactly one row containing `2`. |

## `git_repositories`

| Field | Type | Content |
| --- | --- | --- |
| `id` | INTEGER PK | Internal repository ID. |
| `path` | TEXT UNIQUE | Absolute, resolved root path; Git directory for bare repositories. |

## `git_branches`

PK: `(repository_id, name)`. FK: repository reference; `tip_hash` is not an FK.

| Field | Type | Content |
| --- | --- | --- |
| `repository_id` | INTEGER | Owning repository. |
| `name` | TEXT | Supplied branch name, such as `main` or `origin/main`. |
| `tip_hash` | TEXT | Branch tip resolved once during the last successful import. |
| `commit_limit` | INTEGER | Last requested N, not the total number of stored commits. |
| `imported_at` | TEXT | UTC time of the last successful import. |

## `git_commits`

PK: `(repository_id, hash)`. FK: repository reference.

| Field | Type | Content |
| --- | --- | --- |
| `repository_id` | INTEGER | Owning repository. |
| `hash` | TEXT | Full commit hash. |
| `author_name` | TEXT | Author name from the commit, without `.mailmap` normalization. |
| `author_email` | TEXT | Author email from the commit. |
| `authored_at` | TEXT | Author timestamp with its original time zone. |
| `committer_name` | TEXT | Committer name from the commit. |
| `committer_email` | TEXT | Committer email from the commit. |
| `committed_at` | TEXT | Committer timestamp with its original time zone. |
| `parent_count` | INTEGER | Number of direct parent commits. |
| `is_merge` | INTEGER | `1` when there is more than one parent commit. |

## `git_commit_parents`

PK: `(repository_id, commit_hash, position)`. FK: commit reference; `parent_hash` is not an FK.

| Field | Type | Content |
| --- | --- | --- |
| `repository_id` | INTEGER | Owning repository. |
| `commit_hash` | TEXT | Child commit. |
| `position` | INTEGER | Parent position, starting at 0; first parent at 0. |
| `parent_hash` | TEXT | Full parent hash, potentially outside the imported selection. |

## `git_file_changes`

PK: `(repository_id, commit_hash, position)`. FK: commit reference.

| Field | Type | Content |
| --- | --- | --- |
| `repository_id` | INTEGER | Owning repository. |
| `commit_hash` | TEXT | Commit introducing the change. |
| `position` | INTEGER | Position in Git's diff output, starting at 0. |
| `change_type` | TEXT | Git status letter, such as `A`, `M`, `D`, `R`, `C`, `T`. |
| `old_path` | TEXT ? | Previous path for a rename or copy; otherwise `NULL`. |
| `path` | TEXT | Affected path; destination path for a rename or copy. |
| `similarity` | INTEGER ? | Git similarity/status percentage if supplied; otherwise `NULL`. |
| `lines_added` | INTEGER ? | Added lines reported by Git numstat; `NULL` for binary or not yet backfilled changes. |
| `lines_deleted` | INTEGER ? | Deleted lines reported by Git numstat; `NULL` for binary or not yet backfilled changes. |
| `churn` | INTEGER ? | `lines_added + lines_deleted`; replacing one line counts twice. `NULL` for binary or not yet backfilled changes. |
| `is_binary` | INTEGER ? | `1` for Git numstat binary changes, `0` for numeric statistics; `NULL` until backfilled. |

| Comparison | Rule |
| --- | --- |
| Regular commit | Against its parent commit. |
| Root commit | Against the empty tree. |
| Merge | Against the first parent commit. |
| Rename | Git heuristic with 50% minimum similarity; no persistent file identity. |
| Binary file | Path change with `is_binary=1`; line counts and churn are `NULL`. |
| Submodule | Git's numstat pointer-change counts; no recursive submodule import. |

## `git_merge_analysis`

PK: `(repository_id, commit_hash)`. FK: commit reference. One row per imported merge.

| Field | Type | Content |
| --- | --- | --- |
| `repository_id` | INTEGER | Owning repository. |
| `commit_hash` | TEXT | Analyzed merge commit. |
| `status` | TEXT | `clean`, `conflicts` or `unknown`. |
| `git_version` | TEXT | Full `git --version` output at reconstruction time. |
| `method` | TEXT | `reconstructed_merge_tree`. |
| `error` | TEXT ? | Failure/abort reason for `unknown`; otherwise `NULL`. |

| Status | Meaning |
| --- | --- |
| `clean` | Two parents reconstructed without conflicts using `git merge-tree --write-tree`. |
| `conflicts` | Git reports conflicts; individual conflict-file entries may still be absent. |
| `unknown` | More than two parents, or failed/invalid reconstruction. |

## `git_merge_conflict_files`

PK: `(repository_id, commit_hash, path)`. FK: merge reference.

| Field | Type | Content |
| --- | --- | --- |
| `repository_id` | INTEGER | Owning repository. |
| `commit_hash` | TEXT | Associated merge commit. |
| `path` | TEXT | Path reported by Git with unresolved conflict stages. |

## `git_merge_conflicts`

PK: `(repository_id, commit_hash, position)`. FK: merge reference.

| Field | Type | Content |
| --- | --- | --- |
| `repository_id` | INTEGER | Owning repository. |
| `commit_hash` | TEXT | Associated merge commit. |
| `position` | INTEGER | Recorded conflict-message position, starting at 0. |
| `conflict_type` | TEXT | Git conflict type, such as `CONFLICT (content)`; repeated occurrences are possible. |

## `git_merge_conflict_paths`

PK: `(repository_id, commit_hash, conflict_position, path)`.
FK: `(repository_id, commit_hash, conflict_position)` → `git_merge_conflicts(repository_id, commit_hash, position)`.

| Field | Type | Content |
| --- | --- | --- |
| `repository_id` | INTEGER | Owning repository. |
| `commit_hash` | TEXT | Associated merge commit. |
| `conflict_position` | INTEGER | Position of the associated conflict message. |
| `path` | TEXT | Path affected by the structured Git conflict message. |

## Indexes and limits

| Object/property | Content |
| --- | --- |
| `git_changes_by_path` | Index on `git_file_changes(repository_id, path)`. |
| `git_commits_by_author` | Index on `git_commits(repository_id, author_email, authored_at)`. |
| Views | None. |
| Branch association | No stored commit selection per branch or history of individual runs. |
| Author time | Commit metadata, not proof of when editing occurred. |
| Merge conflicts | Retrospective reconstruction, not proof of historical conflicts or their resolution. |
| Merge committer | Creator of the merge commit, not proof of who resolved conflicts. |
| Older text messages | Conflict types without guessed path mappings; free-form message text is not stored. |
| Not stored | Commit messages, diffs, file contents. |

### Schema v3: disjoint line categories

`git_file_changes` additionally contains nullable INTEGER columns `lines_created`,
`lines_removed` (deleted), and `lines_changed`. A local Myers replacement block
pairs min(added, deleted) lines as changed; excess lines are created or removed.
Context and hunk boundaries separate blocks. Whitespace counts. Binary line
counts remain NULL. The existing `lines_added`, `lines_deleted` and `churn` retain
their definitions; churn = created + removed + 2 × changed. Developer contribution
weights are applied later, independently of these stored counts.

v1/v2 databases migrate transactionally. Append recalculates selected text commits
missing the new counters from Git patches. Nonselected old results remain NULL;
no category counts are guessed from file totals.
