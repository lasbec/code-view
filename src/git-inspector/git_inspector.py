#!/usr/bin/env python3
"""Import Git commit metadata and reconstructed merge conflicts into SQLite."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import time


class InspectionError(Exception):
    pass


def decode(value):
    try:
        return value.decode('utf-8')
    except UnicodeDecodeError as error:
        raise InspectionError('Git output contains non-UTF-8 text or paths; import aborted') from error


class Git:
    def __init__(self, repo):
        self.repo = repo
        self.env = os.environ.copy()
        # Do not allow inherited Git routing variables to select another repo.
        for key in list(self.env):
            if key.startswith('GIT_'):
                del self.env[key]
        self.env.update(LC_ALL='C', GIT_TERMINAL_PROMPT='0', GIT_NO_REPLACE_OBJECTS='1')
        self.env['GIT_CONFIG_COUNT'] = '1'
        self.env['GIT_CONFIG_KEY_0'] = 'core.hooksPath'
        self.env['GIT_CONFIG_VALUE_0'] = os.devnull

    def run(self, *args, env=None, check=True):
        result = subprocess.run(
            ['git', '-C', str(self.repo), *args], stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env or self.env,
        )
        if check and result.returncode:
            raise InspectionError(decode(result.stderr).strip() or 'Git command failed')
        return result


SCHEMA = [
    """CREATE TABLE git_inspector_schema (version INTEGER NOT NULL)""",
    "INSERT INTO git_inspector_schema VALUES (1)",
    """CREATE TABLE git_repositories (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE)""",
    """CREATE TABLE git_commits (
        repository_id INTEGER NOT NULL REFERENCES git_repositories(id) ON DELETE CASCADE,
        hash TEXT NOT NULL, author_name TEXT NOT NULL, author_email TEXT NOT NULL,
        authored_at TEXT NOT NULL, committer_name TEXT NOT NULL,
        committer_email TEXT NOT NULL, committed_at TEXT NOT NULL,
        parent_count INTEGER NOT NULL, is_merge INTEGER NOT NULL,
        PRIMARY KEY (repository_id, hash))""",
    """CREATE TABLE git_commit_parents (
        repository_id INTEGER NOT NULL, commit_hash TEXT NOT NULL,
        position INTEGER NOT NULL, parent_hash TEXT NOT NULL,
        PRIMARY KEY (repository_id, commit_hash, position),
        FOREIGN KEY (repository_id, commit_hash) REFERENCES git_commits ON DELETE CASCADE)""",
    """CREATE TABLE git_file_changes (
        repository_id INTEGER NOT NULL, commit_hash TEXT NOT NULL,
        position INTEGER NOT NULL, change_type TEXT NOT NULL,
        old_path TEXT, path TEXT NOT NULL, similarity INTEGER,
        PRIMARY KEY (repository_id, commit_hash, position),
        FOREIGN KEY (repository_id, commit_hash) REFERENCES git_commits ON DELETE CASCADE)""",
    """CREATE TABLE git_branches (
        repository_id INTEGER NOT NULL REFERENCES git_repositories(id) ON DELETE CASCADE,
        name TEXT NOT NULL, tip_hash TEXT NOT NULL, commit_limit INTEGER NOT NULL,
        imported_at TEXT NOT NULL, PRIMARY KEY (repository_id, name))""",
    """CREATE TABLE git_merge_analysis (
        repository_id INTEGER NOT NULL, commit_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('clean', 'conflicts', 'unknown')),
        git_version TEXT NOT NULL, method TEXT NOT NULL, error TEXT,
        PRIMARY KEY (repository_id, commit_hash),
        FOREIGN KEY (repository_id, commit_hash) REFERENCES git_commits ON DELETE CASCADE)""",
    """CREATE TABLE git_merge_conflict_files (
        repository_id INTEGER NOT NULL, commit_hash TEXT NOT NULL, path TEXT NOT NULL,
        PRIMARY KEY (repository_id, commit_hash, path),
        FOREIGN KEY (repository_id, commit_hash) REFERENCES git_merge_analysis ON DELETE CASCADE)""",
    """CREATE TABLE git_merge_conflicts (
        repository_id INTEGER NOT NULL, commit_hash TEXT NOT NULL,
        position INTEGER NOT NULL, conflict_type TEXT NOT NULL,
        PRIMARY KEY (repository_id, commit_hash, position),
        FOREIGN KEY (repository_id, commit_hash) REFERENCES git_merge_analysis ON DELETE CASCADE)""",
    """CREATE TABLE git_merge_conflict_paths (
        repository_id INTEGER NOT NULL, commit_hash TEXT NOT NULL,
        conflict_position INTEGER NOT NULL, path TEXT NOT NULL,
        PRIMARY KEY (repository_id, commit_hash, conflict_position, path),
        FOREIGN KEY (repository_id, commit_hash, conflict_position)
            REFERENCES git_merge_conflicts ON DELETE CASCADE)""",
    "CREATE INDEX git_changes_by_path ON git_file_changes(repository_id, path)",
    "CREATE INDEX git_commits_by_author ON git_commits(repository_id, author_email, authored_at)",
]


def ensure_schema(db):
    existing = {r[0] for r in db.execute('SELECT name FROM sqlite_master')}
    if 'git_inspector_schema' not in existing:
        collisions = {name for name in existing if name in {
            'git_repositories', 'git_commits', 'git_commit_parents', 'git_file_changes',
            'git_branches', 'git_merge_analysis', 'git_merge_conflict_files',
            'git_merge_conflicts', 'git_merge_conflict_paths',
            'git_changes_by_path', 'git_commits_by_author'}}
        if collisions:
            raise InspectionError('Existing objects conflict with inspector schema: ' + ', '.join(sorted(collisions)))
        for statement in SCHEMA:
            db.execute(statement)
    elif db.execute('SELECT version FROM git_inspector_schema').fetchall() != [(1,)]:
        raise InspectionError('Unsupported git-inspector schema version')


def file_changes(git, commit, parents):
    args = ['diff-tree', '--no-commit-id', '--name-status', '-z', '-r',
            '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '-M50%']
    args += [parents[0], commit] if parents else ['--root', commit]
    tokens = git.run(*args).stdout.split(b'\0')
    index = 0
    while index < len(tokens) and tokens[index]:
        status = decode(tokens[index])
        path = decode(tokens[index + 1])
        index += 2
        old_path = None
        if status[0] in 'RC':
            old_path, path = path, decode(tokens[index])
            index += 1
        yield status[0], old_path, path, int(status[1:]) if status[1:] else None


def parse_merge(output):
    """Read structured -z messages and tolerate documented free-text output."""
    fields = output.split(b'\0')
    if not re.fullmatch(rb'[0-9a-f]{40}|[0-9a-f]{64}', fields[0]):
        raise ValueError('Invalid merge-tree result')
    index = 1
    files = []
    while index < len(fields) and fields[index]:
        files.append(decode(fields[index]))
        index += 1
    messages = fields[index + 1:]
    conflicts = []
    if messages and messages[0].isdigit():
        index = 0
        while index < len(messages) and messages[index]:
            count = int(messages[index])
            paths = [decode(p) for p in messages[index + 1:index + 1 + count]]
            kind = decode(messages[index + 1 + count])
            # The next field is human-readable text; do not persist it.
            if kind.startswith('CONFLICT'):
                conflicts.append((kind, paths))
            index += count + 3
    else:
        # Free-text output has no reliable machine-readable type/path associations.
        for kind in re.findall(rb'^CONFLICT \(([^\n]*?)\):', b'\0'.join(messages), re.MULTILINE):
            conflicts.append(('CONFLICT (' + decode(kind) + ')', []))
    return sorted(set(files)), conflicts


def analyze_merge(git, parents, object_dir):
    if len(parents) != 2:
        return 'unknown', [], [], 'Only merges with two parents can be reconstructed'
    env = git.env.copy()
    env['GIT_OBJECT_DIRECTORY'] = str(object_dir)
    source = decode(git.run('rev-parse', '--git-path', 'objects').stdout).strip()
    source = Path(source)
    if not source.is_absolute():
        source = git.repo / source
    # Git accepts C-style quoted alternate paths, including colons and spaces.
    env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = json.dumps(str(source.resolve()), ensure_ascii=False)
    try:
        result = git.run('merge-tree', '--write-tree', '--name-only', '--messages', '-z',
                         *parents, env=env, check=False)
        if result.returncode not in (0, 1):
            return 'unknown', [], [], decode(result.stderr).strip() or 'merge-tree failed'
        files, conflicts = parse_merge(result.stdout)
        return ('conflicts' if result.returncode else 'clean'), files, conflicts, None
    except (ValueError, IndexError) as error:
        return 'unknown', [], [], str(error)


def inspect(repo, branch, output, limit, mode, progress=None):
    progress = progress or (lambda *args: None)
    progress('preparing', 0, None)
    git = Git(Path(repo).resolve())
    version = decode(git.run('--version').stdout).strip()
    match = re.search(r'(\d+)\.(\d+)', version)
    if not match or tuple(map(int, match.groups())) < (2, 38):
        raise InspectionError('Git >= 2.38.0 required; found ' + version)
    # Canonicalize subdirectory arguments to the repository's root.
    bare = git.run('rev-parse', '--is-bare-repository').stdout.strip() == b'true'
    root = git.run('rev-parse', '--absolute-git-dir' if bare else '--show-toplevel').stdout
    git.repo = Path(os.fsdecode(root.rstrip(b'\n'))).resolve()
    git.run('check-ref-format', 'refs/heads/' + branch)
    tip = None
    for ref in ('refs/heads/' + branch, 'refs/remotes/' + branch):
        result = git.run('rev-parse', '--verify', ref + '^{commit}', check=False)
        if result.returncode == 0:
            tip = result.stdout.strip().decode('ascii')
            break
    if tip is None:
        raise InspectionError('Branch not found: ' + branch)
    commits = git.run('rev-list', '--topo-order', '--max-count=' + str(limit), tip).stdout.splitlines()
    progress('processing', 0, len(commits))
    shallow_location = git.run('rev-parse', '--git-path', 'shallow').stdout
    shallow_path = Path(os.fsdecode(shallow_location.rstrip(b'\n')))
    if not shallow_path.is_absolute():
        shallow_path = git.repo / shallow_path
    boundaries = set(shallow_path.read_bytes().splitlines()) if shallow_path.exists() else set()
    if boundaries.intersection(commits):
        raise InspectionError('Selected history crosses a shallow boundary; fetch full history first')
    output = Path(output).resolve()
    if not output.parent.is_dir():
        raise InspectionError('Output directory does not exist: ' + str(output.parent))
    inserted = 0
    unknown = 0
    with tempfile.TemporaryDirectory(prefix='git-inspector-') as temporary:
        db = sqlite3.connect(output)
        try:
            db.execute('PRAGMA foreign_keys = ON')
            db.execute('BEGIN IMMEDIATE')
            ensure_schema(db)
            repo_path = str(git.repo)
            if mode == 'replace':
                db.execute('DELETE FROM git_repositories WHERE path = ?', (repo_path,))
            db.execute('INSERT OR IGNORE INTO git_repositories(path) VALUES (?)', (repo_path,))
            repo_id = db.execute('SELECT id FROM git_repositories WHERE path = ?', (repo_path,)).fetchone()[0]
            for completed, raw_hash in enumerate(commits, 1):
                commit = raw_hash.decode('ascii')
                if db.execute('SELECT 1 FROM git_commits WHERE repository_id=? AND hash=?', (repo_id, commit)).fetchone():
                    progress('processing', completed, len(commits))
                    continue
                metadata = git.run('show', '-s', '--no-show-signature',
                    '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%P', commit).stdout
                values = [decode(v) for v in metadata.rstrip(b'\n').split(b'\0')]
                parents = values.pop().split()
                db.execute('INSERT INTO git_commits VALUES (?,?,?,?,?,?,?,?,?,?)',
                           (repo_id, commit, *values, len(parents), int(len(parents) > 1)))
                for position, parent in enumerate(parents):
                    db.execute('INSERT INTO git_commit_parents VALUES (?,?,?,?)', (repo_id, commit, position, parent))
                for position, change in enumerate(file_changes(git, commit, parents)):
                    db.execute('INSERT INTO git_file_changes VALUES (?,?,?,?,?,?,?)', (repo_id, commit, position, *change))
                if len(parents) > 1:
                    status, files, conflicts, error = analyze_merge(git, parents, Path(temporary))
                    db.execute('INSERT INTO git_merge_analysis VALUES (?,?,?,?,?,?)',
                               (repo_id, commit, status, version, 'reconstructed_merge_tree', error))
                    for path in files:
                        db.execute('INSERT INTO git_merge_conflict_files VALUES (?,?,?)', (repo_id, commit, path))
                    for position, (kind, paths) in enumerate(conflicts):
                        db.execute('INSERT INTO git_merge_conflicts VALUES (?,?,?,?)', (repo_id, commit, position, kind))
                        for path in set(paths):
                            db.execute('INSERT INTO git_merge_conflict_paths VALUES (?,?,?,?)', (repo_id, commit, position, path))
                    unknown += status == 'unknown'
                inserted += 1
                progress('processing', completed, len(commits))
            progress('finalizing', len(commits), len(commits))
            db.execute('''INSERT INTO git_branches VALUES (?,?,?,?,?)
                ON CONFLICT(repository_id, name) DO UPDATE SET tip_hash=excluded.tip_hash,
                commit_limit=excluded.commit_limit, imported_at=excluded.imported_at''',
                (repo_id, branch, tip, limit, datetime.now(timezone.utc).isoformat()))
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()
    return len(commits), inserted, unknown


def positive_int(value):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError('must be greater than zero')
    return number


def progress_reporter(enabled):
    last = float('-inf')

    def report(status, completed, total):
        nonlocal last
        now = time.monotonic()
        if not enabled or (status == 'processing' and completed not in (0, total) and now - last < 0.1):
            return
        last = now
        print('CODE_VIEW_PROGRESS ' + json.dumps(dict(status=status, completed=completed, total=total)),
              file=sys.stderr, flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, type=Path, help='Local repository path')
    parser.add_argument('--branch', required=True, help='Local branch or remote-tracking branch, e.g. origin/main')
    parser.add_argument('--output', required=True, type=Path, help='New or existing SQLite file')
    parser.add_argument('--commits', required=True, type=positive_int, help='Number of reachable commits to inspect')
    parser.add_argument('--mode', required=True, choices=('append', 'replace'))
    parser.add_argument('--progress', action='store_true', help='Emit structured progress events on stderr')
    args = parser.parse_args()
    try:
        selected, inserted, unknown = inspect(args.repo, args.branch, args.output, args.commits, args.mode, progress_reporter(args.progress))
    except (InspectionError, sqlite3.Error, OSError) as error:
        print('Error: ' + str(error), file=sys.stderr)
        return 1
    print(f'{selected} commits selected, {inserted} imported, {unknown} new merge analyses unknown. SQLite: {args.output}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
