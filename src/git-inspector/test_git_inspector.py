import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import git_inspector as inspector


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.output = self.root / 'analysis.sqlite'
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Test Author')
        self.git('config', 'user.email', 'author@example.test')
        self.git('config', 'commit.gpgsign', 'false')
        self.git('config', 'core.autocrlf', 'false')

    def git(self, *args, check=True):
        return subprocess.run(['git', '-C', str(self.repo), *args],
                              capture_output=True, check=check)

    def commit(self, name, contents):
        (self.repo / name).write_text(contents)
        self.git('add', '--all')
        self.git('commit', '-m', 'not to be stored')
        return self.git('rev-parse', 'HEAD').stdout.strip().decode()

    def query(self, sql):
        with sqlite3.connect(self.output) as db:
            return db.execute(sql).fetchall()

    def run_import(self, limit=100, mode='append', branch='main'):
        return inspector.inspect(self.repo, branch, self.output, limit, mode)

    def test_append_replace_and_existing_database(self):
        with sqlite3.connect(self.output) as db:
            db.execute('CREATE TABLE unrelated (value TEXT)')
            db.execute("INSERT INTO unrelated VALUES ('keep')")
        self.commit('first.txt', 'one')
        self.commit('second.txt', 'two')
        self.assertEqual(self.run_import(), (2, 2, 0))
        self.assertEqual(self.run_import(), (2, 0, 0))
        self.commit('third.txt', 'three')
        self.assertEqual(self.run_import(limit=2), (2, 1, 0))
        self.assertEqual(self.query('SELECT count(*) FROM git_commits'), [(3,)])
        self.run_import(limit=1, mode='replace')
        self.assertEqual(self.query('SELECT count(*) FROM git_commits'), [(1,)])
        self.assertEqual(self.query('SELECT value FROM unrelated'), [('keep',)])
        self.assertEqual(self.query('PRAGMA foreign_key_check'), [])
        self.assertEqual(self.query('SELECT count(*) FROM git_branches'), [(1,)])

    def test_root_rename_delete_and_unusual_paths(self):
        old = 'ä space\tline\n.txt'
        new = 'renamed\t\n.txt'
        self.commit(old, 'same contents\n')
        self.git('mv', old, new)
        self.git('commit', '-m', 'rename')
        self.git('rm', new)
        self.git('commit', '-m', 'delete')
        self.run_import()
        self.assertEqual(self.query("SELECT change_type, old_path, path FROM git_file_changes ORDER BY change_type"),
                         [('A', None, old), ('D', None, new), ('R', old, new)])
        self.assertEqual(self.query('SELECT change_type, lines_added, lines_deleted, churn FROM git_file_changes ORDER BY change_type'),
                         [('A', 1, 0, 1), ('D', 0, 1, 1), ('R', 0, 0, 0)])

    def test_churn_counts_edits_and_binary_changes(self):
        self.commit('text.txt', 'one\ntwo\nthree\n')
        self.commit('text.txt', 'one\nchanged\nthree\nfour\n')
        (self.repo / 'binary.dat').write_bytes(b'\x00\x01\x02')
        self.git('add', '--all')
        self.git('commit', '-m', 'binary')
        self.run_import()
        self.assertEqual(self.query('''SELECT lines_added, lines_deleted, churn, is_binary
            FROM git_file_changes WHERE path='text.txt' ORDER BY lines_deleted'''),
                         [(3, 0, 3, 0), (2, 1, 3, 0)])
        self.assertEqual(self.query("SELECT lines_added, lines_deleted, churn, is_binary FROM git_file_changes WHERE path='binary.dat'"),
                         [(None, None, None, 1)])

    def test_v1_migration_backfills_selected_commits_on_append(self):
        self.commit('one', 'one\n')
        self.commit('two', 'two\nthree\n')
        self.run_import()
        with sqlite3.connect(self.output) as db:
            for column in ('lines_added', 'lines_deleted', 'churn', 'is_binary'):
                db.execute(f'ALTER TABLE git_file_changes DROP COLUMN {column}')
            db.execute('UPDATE git_inspector_schema SET version=1')
        self.assertEqual(self.run_import(limit=1), (1, 0, 0))
        self.assertEqual(self.query('SELECT version FROM git_inspector_schema'), [(2,)])
        self.assertEqual(self.query('SELECT path,churn FROM git_file_changes ORDER BY path'), [('one', None), ('two', 2)])
        self.assertEqual(self.run_import(), (2, 0, 0))
        self.assertEqual(self.query('SELECT path,churn FROM git_file_changes ORDER BY path'), [('one', 1), ('two', 2)])
        with patch.object(inspector, 'update_churn', side_effect=AssertionError('already recorded')):
            self.assertEqual(self.run_import(), (2, 0, 0))

    def test_conflict_reconstruction_preserves_source(self):
        self.commit('conflict.txt', 'base\n')
        self.git('checkout', '-b', 'feature')
        self.commit('conflict.txt', 'feature\n')
        self.git('checkout', 'main')
        self.commit('conflict.txt', 'main\n')
        result = self.git('merge', 'feature', check=False)
        self.assertEqual(result.returncode, 1)
        merge = self.commit('conflict.txt', 'resolved\n')
        (self.repo / 'untracked.txt').write_text('leave me')
        self.git('config', 'merge.conflictstyle', 'diff3')
        status_before = self.git('status', '--porcelain', '-z').stdout
        index_before = (self.repo / '.git/index').read_bytes()
        objects_before = sorted(str(p.relative_to(self.repo)) for p in (self.repo / '.git/objects').rglob('*'))
        self.assertEqual(self.run_import(), (4, 4, 0))
        self.assertEqual(self.query('SELECT status FROM git_merge_analysis'), [('conflicts',)])
        self.assertEqual(self.query('SELECT path FROM git_merge_conflict_files'), [('conflict.txt',)])
        self.assertEqual(self.query('SELECT conflict_type FROM git_merge_conflicts'), [('CONFLICT (contents)',)])
        self.assertEqual(self.query(f"SELECT path FROM git_file_changes WHERE commit_hash='{merge}'"), [('conflict.txt',)])
        self.assertEqual(self.query(f"SELECT lines_added,lines_deleted,churn FROM git_file_changes WHERE commit_hash='{merge}'"), [(1, 1, 2)])
        self.assertEqual(self.git('status', '--porcelain', '-z').stdout, status_before)
        self.assertEqual((self.repo / '.git/index').read_bytes(), index_before)
        self.assertEqual(sorted(str(p.relative_to(self.repo)) for p in (self.repo / '.git/objects').rglob('*')), objects_before)

    def test_clean_merge(self):
        self.commit('base', 'base')
        self.git('checkout', '-b', 'feature')
        self.commit('feature', 'feature')
        self.git('checkout', 'main')
        self.commit('main', 'main')
        self.git('merge', '--no-ff', 'feature', '-m', 'merge')
        self.run_import()
        self.assertEqual(self.query('SELECT status FROM git_merge_analysis'), [('clean',)])

    def test_replace_preserves_other_repository(self):
        self.commit('one', 'one')
        self.run_import()
        other = self.root / 'other'
        self.git('clone', str(self.repo), str(other))
        inspector.inspect(other, 'main', self.output, 100, 'append')
        self.run_import(limit=1, mode='replace')
        self.assertEqual(self.query('SELECT count(*) FROM git_repositories'), [(2,)])
        self.assertEqual(self.query('SELECT count(*) FROM git_commits'), [(2,)])

    def test_replace_rolls_back_after_failure(self):
        self.commit('one', 'one')
        self.run_import()
        self.commit('two', 'two')
        with patch.object(inspector, 'file_changes', side_effect=inspector.InspectionError('failure')):
            with self.assertRaises(inspector.InspectionError):
                self.run_import(mode='replace')
        self.assertEqual(self.query('SELECT count(*) FROM git_commits'), [(1,)])

    def test_existing_schema_collision_is_not_overwritten(self):
        self.commit('one', 'one')
        with sqlite3.connect(self.output) as db:
            db.execute('CREATE TABLE git_commits (original TEXT)')
        with self.assertRaises(inspector.InspectionError):
            self.run_import(mode='replace')
        self.assertEqual(self.query('PRAGMA table_info(git_commits)')[0][1], 'original')

    def test_author_and_committer_and_no_messages(self):
        with patch.dict(os.environ, {'GIT_AUTHOR_NAME': 'Original Author',
                                    'GIT_AUTHOR_EMAIL': 'original@example.test',
                                    'GIT_AUTHOR_DATE': '2023-01-02T12:00:00+02:00',
                                    'GIT_COMMITTER_DATE': '2023-01-03T11:00:00-03:00'}):
            self.commit('one', 'one')
        self.run_import()
        self.assertEqual(self.query('SELECT author_name, committer_name, authored_at, committed_at FROM git_commits'),
                         [('Original Author', 'Test Author', '2023-01-02T12:00:00+02:00', '2023-01-03T11:00:00-03:00')])
        self.assertNotIn(b'not to be stored', self.output.read_bytes())

    def test_remote_branch_and_subdirectory(self):
        commit = self.commit('one', 'one')
        self.git('update-ref', 'refs/remotes/origin/main', commit)
        subdir = self.repo / 'sub'
        subdir.mkdir()
        inspector.inspect(subdir, 'origin/main', self.output, 10, 'append')
        self.assertEqual(self.query('SELECT path FROM git_repositories'), [(str(self.repo),)])

    def test_shallow_history_fails_without_partial_import(self):
        self.commit('one', 'one')
        self.commit('two', 'two')
        shallow = self.root / 'shallow'
        self.git('clone', '--depth', '1', self.repo.as_uri(), str(shallow))
        with self.assertRaisesRegex(inspector.InspectionError, 'shallow boundary'):
            inspector.inspect(shallow, 'main', self.output, 100, 'append')
        self.assertEqual(self.query("SELECT name FROM sqlite_master WHERE type='table'"), [])


class ParserTests(unittest.TestCase):
    def test_legacy_free_text_types_have_no_guessed_path_mapping(self):
        output = b'a' * 40 + b'\0one\0\0Auto-merging one\nCONFLICT (content): text\n'
        self.assertEqual(inspector.parse_merge(output),
                         (['one'], [('CONFLICT (content)', [])]))
    def test_modern_conflict_links_multiple_paths(self):
        output = (b'a' * 40 + b'\0one\0two\0\0' +
                  b'2\0one\0two\0CONFLICT (rename/rename)\0human text\0')
        self.assertEqual(inspector.parse_merge(output),
                         (['one', 'two'], [('CONFLICT (rename/rename)', ['one', 'two'])]))

    def test_octopus_is_unknown(self):
        self.assertEqual(inspector.analyze_merge(None, ['a', 'b', 'c'], None)[0], 'unknown')

    def test_old_git_is_rejected_before_creating_database(self):
        result = subprocess.CompletedProcess([], 0, b'git version 2.34.1\n', b'')
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / 'absent.sqlite'
            with patch.object(inspector.Git, 'run', return_value=result):
                with self.assertRaisesRegex(inspector.InspectionError, '2.38.0'):
                    inspector.inspect(Path(root), 'main', output, 10, 'append')
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
