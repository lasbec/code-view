# Git inspection result schema

SQLite, schema version `1`. See [usage](usage.md).

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
| `version` | INTEGER | Schema version; exactly one row containing `1`. |

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

| Comparison | Rule |
| --- | --- |
| Regular commit | Against its parent commit. |
| Root commit | Against the empty tree. |
| Merge | Against the first parent commit. |
| Rename | Git heuristic with 50% minimum similarity; no persistent file identity. |
| Binary file/submodule | Path change only; no content or recursive submodule import. |

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
