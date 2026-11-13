import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDataCache } from '../public/frontend-state.js';

test('data cache shares pending requests, isolates callers, retries errors and clears in-flight entries', async () => {
  const cache = createDataCache();
  let calls = 0, resolve;
  const fetchValue = () => { calls++; return new Promise(r => { resolve = r; }); };
  const first = cache.get('files', fetchValue), second = cache.get('files', fetchValue);
  await Promise.resolve(); resolve({ files: [{ score: 5 }] });
  const [a,b] = await Promise.all([first,second]);
  assert.equal(calls,1); a.files[0].score = 999; assert.equal(b.files[0].score,5);
  assert.equal((await cache.get('files',fetchValue)).files[0].score,5);
  const old = cache.get('pending',fetchValue); await Promise.resolve();
  cache.clear(); resolve({ old: true }); await old;
  assert.deepEqual(await cache.get('pending',async()=>({ fresh: true })),{ fresh: true });
  await assert.rejects(cache.get('failed',async()=>{ throw new Error('Offline'); }),/Offline/);
  assert.equal(await cache.get('failed',async()=>42),42);
  assert.equal(await cache.get('files',async()=>7),7);
});

test('cache evicts the least recently used entries', async () => {
  const cache = createDataCache(2);
  await cache.get('a',async()=>1); await cache.get('b',async()=>2);
  await cache.get('a',async()=>99); await cache.get('c',async()=>3);
  assert.equal(await cache.get('b',async()=>22),22);
});
