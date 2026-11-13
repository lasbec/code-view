import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressStream } from '../progress.mjs';
import { progressHtml } from '../public/progress-view.js';
import { Jobs } from '../jobs.mjs';

test('progress framing handles fragmented UTF-8, several events, and a final unterminated log', () => {
  const events = [], logs = [];
  const stream = progressStream(e => events.push(e), l => logs.push(l));
  const input = Buffer.from('CODE_VIEW_PROGRESS {"status":"processing","completed":15,"total":200}\nWarning: Größen\nCODE_VIEW_PROGRESS {"status":"finalizing","completed":200,"total":200}\nLast log');
  for (let i = 0; i < input.length; i++) stream.write(input.subarray(i, i + 1));
  stream.end();
  assert.deepEqual(events, [{ status: 'processing', completed: 15, total: 200 }, { status: 'finalizing', completed: 200, total: 200 }]);
  assert.equal(logs.join(''), 'Warning: Größen\nLast log\n');
});
test('preparation details pass through to the UI without marking files completed', () => {
  const events = [];
  const stream = progressStream(e => events.push(e), () => {});
  stream.write(Buffer.from('CODE_VIEW_PROGRESS {"status":"preparing","completed":0,"total":3231,"detail":"Indexing symbols: 100/3231 files"}\n'));
  stream.end();
  assert.deepEqual(events, [{ status: 'preparing', completed: 0, total: 3231, detail: 'Indexing symbols: 100/3231 files' }]);
});
test('invalid progress never becomes a UI counter', () => {
  const events = [], logs = [];
  const stream = progressStream(e => events.push(e), l => logs.push(l));
  stream.write(Buffer.from('CODE_VIEW_PROGRESS {"status":"processing","completed":20,"total":10}\nCODE_VIEW_PROGRESS broken\n'));
  stream.end();
  assert.equal(events.length, 0); assert.equal(logs.length, 2);
});
test('both bars show exact counts and distinguish finalizing, empty results, and cancellation', () => {
  const job = { name: '<Sample>', status: 'running', activeInspector: 'git', progress: {
    code: { status: 'done', completed: 85, total: 85 }, git: { status: 'processing', completed: 15, total: 200 },
  } };
  let html = progressHtml(job);
  assert.match(html, /85\/85 files/); assert.match(html, /15\/200 commits/);
  assert.match(html, /&lt;Sample&gt;/); assert.match(html, /max="200" value="15"/);
  job.progress.git.detail = '<Preparing dependencies>';
  assert.match(progressHtml(job), /&lt;Preparing dependencies&gt;/);
  job.progress.git.status = 'finalizing'; html = progressHtml(job);
  assert.match(html, /Finalizing/); assert.doesNotMatch(html, /max="200" value=/);
  job.cancelled = true; assert.match(progressHtml(job), /Cancelling/);
  job.status = 'cancelled'; job.progress.git.status = 'cancelled';
  assert.match(progressHtml(job), /max="200" value="15"/);
  job.progress.code = { status: 'done', completed: 0, total: 0 };
  assert.match(progressHtml(job), /0\/0 files/);
});
test('counter updates arrive before inspector exit; failure and cancellation keep the last count', async () => {
  const jobs = new Jobs('/tmp', null);
  const prepare = () => { jobs.current = { status: 'running', progress: { code: { status: 'preparing', completed: 0, total: null } }, cancelled: false, log: '' }; };
  prepare();
  const script = `process.stderr.write('CODE_VIEW_PROGRESS {"status":"processing","completed":85,"total":15698}\\n'); setTimeout(() => process.exit(1), 800);`;
  const run = jobs.command(process.execPath, ['-e', script], false, 'code');
  // Observe the parsed event as it arrives, rather than assuming subprocess startup time.
  const deadline = Date.now() + 5000;
  while (jobs.current.progress.code.completed !== 85 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(jobs.current.status, 'running');
  assert.equal(jobs.current.progress.code.completed, 85);
  await assert.rejects(run, /exited with code 1/);
  assert.equal(jobs.current.progress.code.completed, 85);
  prepare();
  const cancel = jobs.command(process.execPath, ['-e', script.replace('800', '30000')], false, 'code');
  while (jobs.current.progress.code.completed !== 85) await new Promise(r => setTimeout(r, 10));
  jobs.cancel();
  await assert.rejects(cancel, /cancelled/);
  assert.equal(jobs.current.progress.code.completed, 85);
});
