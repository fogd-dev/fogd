import test from 'node:test';
import assert from 'node:assert/strict';
import { submitterStatus } from '../src/submitter-status.mjs';
const id = '00000000-0000-4000-8000-000000000001';
const input = { id, app: 'guestbook', digest: 'a'.repeat(64), status: 'failed', step: 'migrating', submittedAt: '2026-10-22T12:00:00.000Z', error: 'private-sql-error', credentials: 'private-token', version: 'private-runtime', secretRevision: 'private-revision', otherApp: 'private-other-app' };
test('known failed stages preserve useful fixed explanations while discarding raw server fields', () => {
  assert.deepEqual(submitterStatus(input, id), { id, app: 'guestbook', digest: 'a'.repeat(64), status: 'failed', step: 'migrating', submittedAt: input.submittedAt, error: 'A database migration failed or was interrupted. Ask an administrator to inspect the migration before retrying.' });
});
test('unfamiliar states, progress and timestamps cannot become output or imply success', () => {
  assert.deepEqual(submitterStatus({ ...input, status: 'private-status', step: 'private-step', submittedAt: 'private-time' }, id), { id, app: 'guestbook', digest: input.digest, status: 'unknown', step: 'unknown', submittedAt: null, error: null });
  assert.equal(submitterStatus({ ...input, step: 'future-queue-step' }, id).step, 'unknown');
  assert.equal(submitterStatus({ ...input, step: 'future-queue-step' }, id).error, 'Activation failed. Ask an administrator to inspect this release.');
});
test('queue lifecycle failures retain recorded progress and use local explanations without trusting server errors', () => {
  const steps = ['queue-bootstrap-intent', 'publishing-queue-bootstrap', 'waiting-for-queue-bootstrap', 'pausing-delivery',
    'queue-application-intent', 'releasing-delivery', 'transferring-delivery-hold'];
  for (const step of steps) {
    const report = submitterStatus({ ...input, step, error: 'private-server-message' }, id);
    assert.equal(report.step, step); assert.equal(report.status, 'failed'); assert.match(report.error, /administrator/i);
    assert.equal(JSON.stringify(report).includes('private-'), false);
    assert.equal(submitterStatus({ ...input, step, status: 'activating' }, id).error, null);
  }
});
for (const status of ['pending', 'activating', 'active', 'rejected', 'superseded', 'retired']) test(`${status} remains a recorded status and does not echo a stale error`, () => {
  const step = status === 'pending' ? 'submitted' : 'migrating';
  const result = submitterStatus({ ...input, status, step }, id); assert.equal(result.status, status); assert.equal(result.step, step); assert.equal(result.error, null);
});
for (const change of [{ id: '00000000-0000-4000-8000-000000000002' }, { id: 1 }, { digest: 'bad' }, { app: '../other' }, { app: 'PRIVATE' }]) test(`invalid identity ${JSON.stringify(change)} refuses`, () => {
  assert.throws(() => submitterStatus({ ...input, ...change }, id), /invalid|different/);
});

test('a digest array cannot pass identity validation through JavaScript string coercion', () => {
  assert.throws(() => submitterStatus({ ...input, digest: [input.digest] }, id), /invalid/);
});
test('an object-valued step cannot be interpreted or emitted as a progress string', () => {
  const report = submitterStatus({ ...input, step: { toString: 'private-progress' } }, id);
  assert.equal(report.step, 'unknown'); assert.equal(JSON.stringify(report).includes('private-progress'), false);
});

test('parseable timestamps without canonical milliseconds remain unsupported', () => {
  for (const submittedAt of ['2026-10-22T12:00:00Z', '2026-10-22T08:00:00.000-04:00']) assert.equal(submitterStatus({ ...input, submittedAt }, id).submittedAt, null);
});
for (const value of [null, [], 'private-root', 42]) test(`unsupported JSON root ${JSON.stringify(value)} refuses`, () => {
  assert.throws(() => submitterStatus(value, id), /invalid/);
});
