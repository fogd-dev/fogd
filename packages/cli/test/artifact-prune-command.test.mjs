import test from 'node:test';
import assert from 'node:assert/strict';
import { adminCliFixture } from './fixtures/admin-client.mjs';

const id = '00000000-0000-4000-8000-000000000001', artifact = '00000000-0000-4000-8000-000000000002';
const plan = 'a'.repeat(64), csrf = 'c'.repeat(64), artifacts = [{ id: artifact, digest: 'b'.repeat(64), bytes: 3 }];
const receipt = { schema: 1, id, plan, artifacts, reclaimedArtifactBytes: 3 };
const status = { schema: 1, operation: { id, plan, candidates: artifacts, approvedArtifactBytes: 3 }, last: null };
const fixture = (t, respond) => adminCliFixture(t, { respond, command: 'artifacts', defaults: ['prune', plan] });

for (const action of ['prune', 'resume']) test(`CLI ${action} sends exactly one reviewed owner operation`, async t => {
  let body = '';
  const f = await fixture(t, (request, response) => {
    if (request.method === 'GET') { response.end(JSON.stringify({ csrf })); return; }
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => response.end(JSON.stringify({ ...receipt, files: 'private-response' })));
  });
  const result = await f.invoke([action, action === 'prune' ? plan : id]);
  assert.deepEqual(JSON.parse(result.stdout), receipt); assert.equal(result.stderr, '');
  assert.deepEqual(f.calls.map(call => [call.method, call.path]), [['GET', '/v1/admin'], ['POST', action === 'prune' ? '/v1/admin/artifacts/prune' : `/v1/admin/artifacts/prune/${id}/resume`]]);
  assert.deepEqual(JSON.parse(body), action === 'prune' ? { plan } : {});
  assert.ok(f.calls.every(call => call.authorization === 'Basic ' + Buffer.from('admin:private-admin-password').toString('base64')));
});

test('CLI status is one owner read and excludes journal file contents', async t => {
  const f = await fixture(t, (_, response) => response.end(JSON.stringify({ ...status, operation: { ...status.operation, files: 'private-response' } })));
  const result = await f.invoke(['status']);
  assert.deepEqual(JSON.parse(result.stdout), status); assert.equal(result.stderr, '');
  assert.deepEqual(f.calls.map(call => [call.method, call.path]), [['GET', '/v1/admin/artifacts/prune']]);
  assert.doesNotMatch(result.stdout, /private-response|files/);
});

for (const args of [['prune', 'bad'], ['resume', '../other'], ['status', 'extra']]) test(`bad prune arguments refuse before HTTP: ${JSON.stringify(args)}`, async t => {
  const f = await fixture(t, (_, response) => response.end('private-response'));
  await assert.rejects(f.invoke(args), error => error.code === 1 && /Usage:|requires the reviewed/.test(error.stderr) && error.stdout === '');
  assert.deepEqual(f.calls, []);
});

for (const [code, body] of [[503, 'private-response'], [200, 'private-response'], [200, JSON.stringify({ ...receipt, plan: 'f'.repeat(64) })]]) test(`unconfirmed prune response ${code} stays uncertain without replay`, async t => {
  let mutations = 0;
  const f = await fixture(t, (request, response) => {
    if (request.method === 'GET') { response.end(JSON.stringify({ csrf })); return; }
    mutations++; response.statusCode = code; response.end(body);
  });
  await assert.rejects(f.invoke(), error => error.code === 1 && /prune operation is uncertain/.test(error.stderr) && !error.stderr.includes('private-response') && error.stdout === '');
  assert.equal(mutations, 1); assert.equal(f.calls.length, 2);
});

test('a lost prune reply does not resend its approved operation', async t => {
  let mutations = 0;
  const f = await fixture(t, (request, response) => {
    if (request.method === 'GET') { response.end(JSON.stringify({ csrf })); return; }
    mutations++; response.destroy();
  });
  await assert.rejects(f.invoke(), error => error.code === 1 && /uncertain/.test(error.stderr) && error.stdout === '');
  assert.equal(mutations, 1); assert.equal(f.calls.length, 2);
});
