import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { adminCliFixture } from './fixtures/admin-client.mjs';

const id = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002';
const plan = { schema: 1, policy: 'fogd-terminal-artifact-retention-v1', plan: 'a'.repeat(64), retainedArtifactBytes: 5, reclaimableArtifactBytes: 2, protectedArtifactBytes: 3,
  candidates: [{ id, app: 'guestbook', digest: 'b'.repeat(64), status: 'rejected', bytes: 2 }],
  protected: [{ id: other, app: 'guestbook', digest: 'c'.repeat(64), status: 'active', bytes: 3, reasons: ['active', 'operator-pin'] }],
  missing: [{ id: '00000000-0000-4000-8000-000000000003', app: 'guestbook', digest: 'd'.repeat(64), status: 'rejected', reasons: [] }] };
const fixture = (t, respond) => adminCliFixture(t, { respond, command: 'artifacts', defaults: ['plan'] });

test('the real CLI reads one owner plan and projects only retention fields', async t => {
  const response = { ...plan, error: 'private-response', files: 'private-files',
    candidates: [{ ...plan.candidates[0], version: 'private-version', secretRevision: 'private-revision' }],
    protected: [{ ...plan.protected[0], credentials: 'private-credentials' }] };
  const f = await fixture(t, (_, res) => res.end(JSON.stringify(response)));
  const result = await f.invoke();
  assert.deepEqual(JSON.parse(result.stdout), plan);
  assert.deepEqual(f.calls, [{ path: '/v1/admin/artifacts', method: 'GET', authorization: 'Basic ' + Buffer.from('admin:private-admin-password').toString('base64') }]);
  assert.equal(result.stderr, ''); assert.doesNotMatch(result.stdout, /private-/);
  await assert.rejects(access(join(f.root, 'operator.env')), { code: 'ENOENT' });
  await assert.rejects(access(join(f.root, '.fogd')), { code: 'ENOENT' });
});

for (const args of [[], ['prune'], ['plan', 'extra'], ['keep', id]]) test(`unsupported artifact action refuses before HTTP: ${JSON.stringify(args)}`, async t => {
  const f = await fixture(t, (_, response) => response.end(JSON.stringify(plan)));
  await assert.rejects(f.invoke(args), error => error.code === 1 && /Usage: fogd admin artifacts plan/.test(error.stderr) && error.stdout === '');
  assert.deepEqual(f.calls, []);
});

test('a deploy credential does not substitute for owner credentials', async t => {
  const f = await fixture(t, (_, response) => response.end(JSON.stringify(plan)));
  await assert.rejects(f.invoke(['plan'], { FOGD_ADMIN_PASSWORD: '' }), error => error.code === 1 && /Set FOGD_ADMIN_PASSWORD/.test(error.stderr) && !error.stderr.includes('private-builder-token'));
  assert.deepEqual(f.calls, []);
});

for (const [status, message] of [[401, /authentication was refused/], [403, /authentication was refused/], [404, /does not provide artifact retention/], [503, /inspection is unavailable \(HTTP 503\)/]]) test(`artifact HTTP ${status} keeps the response private`, async t => {
  const f = await fixture(t, (_, response) => { response.statusCode = status; response.end('private-server-error'); });
  await assert.rejects(f.invoke(), error => error.code === 1 && message.test(error.stderr) && !error.stderr.includes('private-') && error.stdout === '');
  assert.equal(f.calls.length, 1);
});

for (const [name, body, message] of [['malformed JSON', 'private-response', /unreadable artifact JSON/], ['oversized JSON', 'x'.repeat(4 * 1024 ** 2 + 1), /4 MiB/],
  ['inconsistent totals', JSON.stringify({ ...plan, retainedArtifactBytes: 6 }), /invalid artifact retention plan/],
  ['invalid candidate status', JSON.stringify({ ...plan, candidates: [{ ...plan.candidates[0], status: 'active', error: 'private-response' }] }), /invalid artifact retention plan/],
  ['unknown protection reason', JSON.stringify({ ...plan, protected: [{ ...plan.protected[0], reasons: ['private-response'] }] }), /invalid artifact retention plan/]]) test(`artifact ${name} cannot become output`, async t => {
  const f = await fixture(t, (_, response) => response.end(body));
  await assert.rejects(f.invoke(), error => error.code === 1 && message.test(error.stderr) && !error.stderr.includes('private-response') && error.stdout === '');
});

test('artifact redirects do not forward administrator credentials', async t => {
  const target = await fixture(t, (_, response) => response.end(JSON.stringify(plan)));
  const f = await fixture(t, (_, response) => { response.statusCode = 302; response.setHeader('Location', target.env.FOGD_SERVER); response.end(); });
  await assert.rejects(f.invoke(), error => error.code === 1 && /Cannot read controller artifacts/.test(error.stderr) && error.stdout === '');
  assert.equal(f.calls.length, 1); assert.deepEqual(target.calls, []);
});

test('artifact content types must be JSON', async t => {
  const f = await fixture(t, (_, response) => { response.setHeader('Content-Type', 'text/html'); response.end(JSON.stringify(plan)); });
  await assert.rejects(f.invoke(), error => error.code === 1 && /did not return JSON artifact/.test(error.stderr) && error.stdout === '');
});
