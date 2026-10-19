import assert from 'node:assert/strict';
import { context } from './queue-probe/context.mjs';
import { expect } from './guestbook-browser.mjs';

const [slot, output] = process.argv.slice(2);
const probe = await context(slot, output, { queueName: 'imports' });
const id = 'killed-native';
await probe.queue('resume');
const delayMs = 12000;
assert.ok(delayMs < probe.budget * 1000);
await post({ id: 'unkilled-native', text: 'control mango', delayMs });
await expect.poll(async () => (await job('unkilled-native')).status, { timeout: 120000 }).toBe('complete');
assert.equal((await job('unkilled-native')).attempts, 1);
await probe.save('control', await job('unkilled-native'));
await post({ id, text: 'retained mango', delayMs });
for (const attempt of [1, 2]) {
  await expect.poll(async () => {
    try { return (await job()).attempts; } catch { return null; }
  }, { timeout: 180000 }).toBe(attempt);
  const observedAt = Date.now();
  await probe.compose(['stop', '-t', '0', ...probe.slot.nodes]);
  const stoppedAt = Date.now();
  assert.ok(stoppedAt - observedAt < delayMs / 2, 'Stop must promptly interrupt the held attempt');
  await probe.save(`killed-attempt-${attempt}`, { attempt, observedAt, stoppedAt, delayMs });
  await probe.compose(['start', ...probe.slot.nodes]);
  console.log(`Killed both replicas during attempt ${attempt}; waiting for lease recovery`);
}
await expect.poll(async () => {
  try { return (await probe.queue('info')).stored; } catch { return null; }
}, { timeout: 180000 }).toBe(0);
const exhausted = await job();
assert.equal(exhausted.status, 'accepted');
assert.equal(exhausted.attempts, 2);
assert.equal(exhausted.error, null);
assert.deepEqual(exhausted.results, []);
await probe.save('exhausted', { job: exhausted, queue: await probe.queue('info') });
await post({ id, retry: true });
await expect.poll(async () => (await job()).status, { timeout: 120000 }).toBe('complete');
const completed = await job();
assert.equal(completed.attempts, 3);
assert.equal(completed.input_hash, exhausted.input_hash);
assert.equal(completed.results.length, 1);
assert.equal(completed.results[0].label, 'RETAINED MANGO');
assert.equal(completed.results[0].processor, 'v2');
await post({ id, retry: true });
assert.deepEqual(await job(), completed);
await probe.queue('pause');
await probe.save('reconciled', { job: completed, queue: await probe.queue('info') });
console.log('PASS: two killed consumers exhaust delivery without a failure row; explicit reconciliation replays retained input once');

async function post(body) {
  const response = await probe.http('/api/imports', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(response.status, 202, response.body);
}
async function job(selected = id) {
  const response = await probe.http(`/api/imports?id=${selected}`);
  assert.equal(response.status, 200, response.body);
  return JSON.parse(response.body);
}
