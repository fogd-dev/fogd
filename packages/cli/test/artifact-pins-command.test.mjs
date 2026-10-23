import test from 'node:test';
import assert from 'node:assert/strict';
import { adminCliFixture } from './fixtures/admin-client.mjs';

const id = '00000000-0000-4000-8000-000000000001', digest = 'a'.repeat(64), csrf = 'c'.repeat(64);
const fixture = (t, respond) => adminCliFixture(t, { respond, command: 'artifacts', defaults: ['keep', id, digest] });
const result = kept => ({ schema: 1, id, digest, kept });

for (const action of ['keep', 'unkeep']) test(`real CLI ${action} sends one exact owner mutation after fetching CSRF`, async t => {
  let body = '', headers;
  const f = await fixture(t, (request, response) => {
    if (request.method === 'GET') { response.end(JSON.stringify({ csrf })); return; }
    headers = request.headers;
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => response.end(JSON.stringify({ ...result(action === 'keep'), error: 'private-response' })));
  });
  const response = await f.invoke([action, id, digest]);
  assert.deepEqual(JSON.parse(response.stdout), result(action === 'keep')); assert.equal(response.stderr, '');
  assert.deepEqual(f.calls.map(call => [call.method, call.path]), [['GET', '/v1/admin'], ['POST', `/v1/admin/artifacts/${id}/${action}`]]);
  assert.ok(f.calls.every(call => call.authorization === 'Basic ' + Buffer.from('admin:private-admin-password').toString('base64')));
  assert.equal(headers['x-fogd-csrf'], csrf); assert.deepEqual(JSON.parse(body), { digest });
  assert.doesNotMatch(response.stdout, /private-|csrf/);
});

for (const args of [['keep', '../other', digest], ['keep', id, 'bad'], ['unkeep', id, digest, 'extra']]) test(`invalid pin arguments never contact the server: ${JSON.stringify(args)}`, async t => {
  const f = await fixture(t, (_, response) => response.end('private-response'));
  await assert.rejects(f.invoke(args), error => error.code === 1 && /Usage:|canonical deployment/.test(error.stderr) && error.stdout === '');
  assert.deepEqual(f.calls, []);
});

test('an invalid owner mutation token prevents the POST', async t => {
  const f = await fixture(t, (_, response) => response.end(JSON.stringify({ csrf: 'private-response' })));
  await assert.rejects(f.invoke(), error => error.code === 1 && /update was not sent/.test(error.stderr) && !error.stderr.includes('private-response'));
  assert.deepEqual(f.calls.map(call => call.method), ['GET']);
});

for (const [name, status, body] of [['server failure', 503, 'private-response'], ['invalid JSON', 200, 'private-response'],
  ['wrong receipt', 200, JSON.stringify({ ...result(true), id: 'private-response' })], ['oversized receipt', 200, 'x'.repeat(4097)]]) test(`${name} after pin POST stays uncertain and is never retried`, async t => {
  let mutations = 0;
  const f = await fixture(t, (request, response) => {
    if (request.method === 'GET') { response.end(JSON.stringify({ csrf })); return; }
    mutations++; response.statusCode = status; response.end(body);
  });
  await assert.rejects(f.invoke(), error => error.code === 1 && /update is uncertain/.test(error.stderr) && !error.stderr.includes('private-response') && error.stdout === '');
  assert.equal(mutations, 1); assert.equal(f.calls.length, 2);
});

test('a lost reply after accepting a pin is uncertain without replaying the mutation', async t => {
  let mutations = 0;
  const f = await fixture(t, (request, response) => {
    if (request.method === 'GET') { response.end(JSON.stringify({ csrf })); return; }
    mutations++; response.destroy();
  });
  await assert.rejects(f.invoke(), error => error.code === 1 && /update is uncertain/.test(error.stderr) && error.stdout === '');
  assert.equal(mutations, 1); assert.equal(f.calls.length, 2);
});

for (const [status, message] of [[403, /authorization was refused/], [404, /does not provide artifact pins/], [400, /refused artifact pin update/]]) test(`pin HTTP ${status} withholds private diagnostics`, async t => {
  const f = await fixture(t, (request, response) => {
    if (request.method === 'GET') { response.end(JSON.stringify({ csrf })); return; }
    response.statusCode = status; response.end('private-response');
  });
  await assert.rejects(f.invoke(), error => error.code === 1 && message.test(error.stderr) && !error.stderr.includes('private-response') && error.stdout === '');
  assert.equal(f.calls.length, 2);
});

test('a non-JSON pin acknowledgment remains uncertain', async t => {
  const f = await fixture(t, (request, response) => {
    if (request.method === 'GET') { response.end(JSON.stringify({ csrf })); return; }
    response.setHeader('Content-Type', 'text/html'); response.end(JSON.stringify(result(true)));
  });
  await assert.rejects(f.invoke(), error => error.code === 1 && /update is uncertain/.test(error.stderr) && error.stdout === '');
  assert.equal(f.calls.length, 2);
});

test('a pin redirect cannot forward owner credentials or replay the mutation', async t => {
  const target = await fixture(t, (_, response) => response.end(JSON.stringify(result(true))));
  const f = await fixture(t, (request, response) => {
    if (request.method === 'GET') { response.end(JSON.stringify({ csrf })); return; }
    response.statusCode = 307; response.setHeader('Location', target.env.FOGD_SERVER); response.end();
  });
  await assert.rejects(f.invoke(), error => error.code === 1 && /update is uncertain/.test(error.stderr) && error.stdout === '');
  assert.equal(f.calls.length, 2); assert.deepEqual(target.calls, []);
});
