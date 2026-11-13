# Code View

Inspect TypeScript projects and Git history, with results stored in SQLite.

## TypeScript inspector

- Requires Node.js >= 22.13 with `node:sqlite` and npm supporting lockfile v3, such as npm >= 9.
- Run `npm ci` in `src/code-inspector/typescript` to install TypeScript 5.9.3 and minimatch 11.0.8.
- Provide a readable project, valid tsconfig files and installed project dependencies for full symbol resolution.
- The output location must be writable; missing directories are created. Git is not required.
- Tests: run `npm test` in `src/code-inspector/typescript`.
- [Usage](src/code-inspector/typescript/usage.md) and [schema](src/code-inspector/code-inspection-result-schema.md).

## Git inspector

- Requires Python >= 3.10 with standard-library `sqlite3` and Git >= 2.38.0 in `PATH` for `merge-tree --write-tree`.
- Provide a readable local repository, including bare repositories; selected history must not reach a shallow boundary.
- The output directory must exist; the SQLite file and temporary storage must be writable.
- Git output and file paths must be UTF-8. The script does not clone or fetch repositories.
- Tests: run `python3 -m unittest -v` in `src/git-inspector`.
- [Usage](src/git-inspector/usage.md) and [schema](src/git-inspector/git-inspection-result-schema.md).

Neither script requires a SQLite server. The Git inspector needs no pip packages or Node.js.

## Treemap

Generate interactive HTML snippets from inspector SQLite results, with configurable
area, weighted scores, path filters and a green-to-violet heat scale.
See [usage](src/treemap/USAGE.md).

## Local server

Run `npm start --prefix src/server` and open http://127.0.0.1:3210 to configure
inspections and explore treemaps. Install the inspector and treemap dependencies
first. See [server setup and usage](src/server/README.md).
