import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFailureLogs } from '../../../scripts/cron-probe/selected/failure-logs.mjs';

async function fixture(t, run) {
  const output = await mkdtemp(join(tmpdir(), 'fogd-failure-logs-')); t.after(() => rm(output, { recursive: true, force: true }));
  return { output, env: { FOGD_HOME: output }, project: 'owned-test', run };
}
test('failed runtime logs are retained privately from only the selected project', async t => {
  const calls = [], host = await fixture(t, async (...args) => { calls.push(args); return 'private runtime diagnostic\n'; });
  assert.deepEqual(await captureFailureLogs(host), { captured: true, bytes: 27 });
  const file = join(host.output, 'runtime-failure.log');
  assert.equal(await readFile(file, 'utf8'), 'private runtime diagnostic\n'); assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(calls[0][0], 'docker'); assert.deepEqual(calls[0][1].slice(-2), ['logs', '--no-color']);
  assert.ok(calls[0][1].includes(join(host.output, '.fogd/installations/owned-test/compose.json'))); assert.ok(calls[0][1].includes('owned-test'));
  assert.deepEqual(calls[0][2], { timeout: 30000 });
});
test('a log collection failure cannot replace the original operation failure or expose its detail', async t => {
  const host = await fixture(t, async () => { throw new Error('private Docker failure'); });
  assert.deepEqual(await captureFailureLogs(host), { captured: false });
  await assert.rejects(access(join(host.output, 'runtime-failure.log')), { code: 'ENOENT' });
});
test('an existing failure log is preserved rather than overwritten by another capture', async t => {
  const host = await fixture(t, async () => 'new diagnostic');
  const file = join(host.output, 'runtime-failure.log'); await writeFile(file, 'retained original', { mode: 0o600 });
  assert.deepEqual(await captureFailureLogs(host), { captured: false });
  assert.equal(await readFile(file, 'utf8'), 'retained original');
});
