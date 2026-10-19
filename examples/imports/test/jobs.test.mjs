import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.mjs';
import { submit, retry, getJob } from '../lib/jobs.mjs';
import { processJob, failed } from '../lib/process.mjs';
import { readJson } from '../lib/input.mjs';
const message = (id, attempts = 1) => ({ body: { id }, attempts });
test('retained input and DB record allow retry after queue send fails', async t => {
  const f = fixture(); t.after(f.close);
  await assert.rejects(submit({ ...f, queue: { async send() { throw Error('send outcome unknown'); } } }, { id: 'job', text: 'apple\npear' }), /unknown/);
  assert.equal((await getJob(f.db, 'job')).status, 'accepted');
  await retry(f, 'job'); await processJob(f.db, f.storage, message('job'));
  assert.deepEqual((await getJob(f.db, 'job')).results.map(r => r.label), ['APPLE', 'PEAR']);
});
test('duplicate delivery and resend do not duplicate results or change immutable input', async t => {
  const f = fixture(); t.after(f.close);
  await submit(f, { id: 'job', text: 'apple\napple' });
  await submit(f, { id: 'job', text: 'apple\napple' });
  await assert.rejects(submit(f, { id: 'job', text: 'different' }), e => e.status === 409);
  await processJob(f.db, f.storage, message('job')); await processJob(f.db, f.storage, message('job', 2));
  await failed(f.db, 'job', true);
  const job = await retry(f, 'job');
  assert.equal(job.status, 'complete'); assert.equal(job.results.length, 2); assert.equal(job.error, null);
  assert.equal(f.messages.length, 2);
});
test('terminal failure preserves input for explicit retry, and corrupted input never completes', async t => {
  const f = fixture(); t.after(f.close);
  await submit(f, { id: 'job', text: 'apple', mode: 'fail' });
  await assert.rejects(processJob(f.db, f.storage, message('job', 2)), /Deliberate/);
  await failed(f.db, 'job', true); assert.equal((await getJob(f.db, 'job')).status, 'failed');
  await retry(f, 'job'); await processJob(f.db, f.storage, message('job'));
  assert.equal((await getJob(f.db, 'job')).status, 'complete');
  const other = await submit(f, { id: 'other', text: 'pear' }); f.blobs.set(`inputs/${other.input_hash}`, 'changed');
  await assert.rejects(processJob(f.db, f.storage, message('other')), /hash mismatch/);
  assert.equal((await getJob(f.db, 'other')).results.length, 0);
});
test('body reading cancels oversized chunked input without needing Content-Length', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8192)); }, cancel() { cancelled = true; } });
  await assert.rejects(readJson(new Request('http://local/', { method: 'POST', body, duplex: 'half' })), e => e.status === 413);
  assert.equal(cancelled, true);
});
