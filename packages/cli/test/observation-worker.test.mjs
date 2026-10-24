import test from 'node:test';
import assert from 'node:assert/strict';
import { observeFleet } from '../src/observe/worker.mjs';
const nodes = [{ id: 'node-a', host: 'slot-1-a' }, { id: 'node-b', host: 'slot-1-b' }];
const profile = { fleets: [{ id: 'slot-1', nodes }] }, slot = { id: 'slot-1', nodes: nodes.map(value => value.host) };
const expected = { version: 'PRIVATE_APPROVED_VERSION' };
const leases = () => nodes.map((node, index) => ({ node: node.id, addr: `${node.host}:8081`, key: `${node.id}.json`, processKey: (index ? 'b' : 'a').repeat(64), expiresMs: 11000 }));
function fixture({ members = leases(), version = expected.version } = {}) {
  const events = [], options = [];
  const identity = { members: async () => { events.push('members'); return structuredClone(members); }, verify: async () => { events.push('verify'); } };
  const request = async (url, settings) => {
    events.push(url); options.push(settings);
    return new Response(JSON.stringify(url.endsWith('/state') ? { deployment: { version }, secrets: 'PRIVATE_NATIVE_DATA' } : { ok: true }), { status: 200 });
  };
  return { identity, request, options, events, profile, slot, expected, now: () => 1000 };
}
test('real worker core brackets probes with fresh membership and signed verification, emitting only public facts', async () => {
  const f = fixture(), result = await observeFleet(f);
  assert.deepEqual(result, { identity: 'verified', leases: 'current', replicas: slot.nodes.map(node => ({ node, stateHTTPStatus: 200, healthHTTPStatus: 200, version: 'matches' })) });
  assert.equal(f.events[0], 'members'); assert.deepEqual(f.events.slice(-2), ['verify', 'members']);
  assert.equal(f.options.length, 4); assert.ok(f.options.every(value => value.redirect === 'error' && value.signal instanceof AbortSignal));
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});
for (const [name, mutate] of [
  ['expired lease', value => { value[0].expiresMs = 1000; }],
  ['missing lease', value => { value.pop(); }],
  ['duplicate node', value => { value[1] = value[0]; }],
  ['foreign node', value => { value[0].node = 'other-app-node'; }],
  ['wrong object key', value => { value[0].key = 'other.json'; }],
  ['wrong address', value => { value[0].addr = 'other:8081'; }],
  ['malformed process key', value => { value[0].processKey = 'bad'; }],
  ['array process key', value => { value[0].processKey = [value[0].processKey]; }],
  ['missing expiration', value => { delete value[0].expiresMs; }],
]) test(`${name} cannot be promoted by successful HTTP or a nominal verifier`, async () => {
  const members = leases(); mutate(members); const result = await observeFleet(fixture({ members }));
  assert.equal(result.identity, 'unconfirmed'); assert.equal(result.replicas[0].healthHTTPStatus, 200);
});
test('process-key change during the observation stays unconfirmed', async () => {
  const f = fixture(); let count = 0;
  f.identity.members = async () => { const members = leases(); if (count++) members[0].processKey = 'c'.repeat(64); return members; };
  assert.equal((await observeFleet(f)).identity, 'unconfirmed');
});
test('lease inventory ordering does not change process authority', async () => {
  const f = fixture(); let count = 0;
  f.identity.members = async () => count++ ? leases().reverse() : leases();
  assert.equal((await observeFleet(f)).identity, 'verified');
});
test('a failed signed verification is withheld without its private diagnostics', async () => {
  const f = fixture(); f.identity.verify = async () => { throw new Error('PRIVATE_PROOF_DIAGNOSTIC'); };
  const result = await observeFleet(f); assert.equal(result.identity, 'unconfirmed'); assert.equal(JSON.stringify(result).includes('PRIVATE_PROOF'), false);
});
for (const [version, wanted] of [['other-version', 'differs'], [null, 'unknown'], [12, 'unknown'], [[expected.version], 'unknown']]) test(`native version ${JSON.stringify(version)} is ${wanted}`, async () => {
  const result = await observeFleet(fixture({ version })); assert.equal(result.replicas[0].version, wanted);
});
test('a transport failure yields null statuses and never a body-derived error', async () => {
  const f = fixture(); f.request = async () => { throw new Error('PRIVATE_TRANSPORT_ERROR'); };
  const result = await observeFleet(f);
  assert.deepEqual(result.replicas, slot.nodes.map(node => ({ node, stateHTTPStatus: null, healthHTTPStatus: null, version: 'unknown' })));
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});
for (const bytes of [4 * 1024 ** 2, 4 * 1024 ** 2 + 1]) test(`native state byte bound ${bytes} is ${bytes === 4 * 1024 ** 2 ? 'inclusive' : 'refused'}`, async () => {
  const input = { deployment: { version: expected.version }, padding: '' }, overhead = Buffer.byteLength(JSON.stringify(input));
  input.padding = 'x'.repeat(bytes - overhead); const body = JSON.stringify(input); assert.equal(Buffer.byteLength(body), bytes);
  const f = fixture(); f.request = async url => new Response(url.endsWith('/state') ? body : '{"ok":true}', { status: 200 });
  const result = await observeFleet(f), allowed = bytes === 4 * 1024 ** 2;
  assert.equal(result.replicas[0].stateHTTPStatus, allowed ? 200 : null); assert.equal(result.replicas[0].version, allowed ? 'matches' : 'unknown');
});
test('non-successful state and unhealthy health are recorded without reading private bodies', async () => {
  const f = fixture(); f.request = async () => new Response('PRIVATE_ERROR_BODY', { status: 503 });
  const result = await observeFleet(f); assert.deepEqual(result.replicas[0], { node: slot.nodes[0], stateHTTPStatus: 503, healthHTTPStatus: 503, version: 'unknown' });
  assert.equal(JSON.stringify(result).includes('PRIVATE_ERROR'), false);
});

test('expired but otherwise valid leases remain distinct from unknown membership', async () => {
  const members = leases(); members[0].expiresMs = 999;
  const result = await observeFleet(fixture({ members }));
  assert.equal(result.identity, 'unconfirmed'); assert.equal(result.leases, 'expired');
});
test('failed signed verification can still report current lease inventory without exposing errors', async () => {
  const f = fixture(); f.identity.verify = async () => { throw new Error('PRIVATE_PROOF_DIAGNOSTIC'); };
  const result = await observeFleet(f);
  assert.equal(result.identity, 'unconfirmed'); assert.equal(result.leases, 'current');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});

test('lease renewal between boundaries remains unconfirmed until a fresh observation', async () => {
  const f = fixture(); let reads = 0;
  f.identity.members = async () => { const rows = leases(); if (reads++ === 0) rows[0].expiresMs = 999; return rows; };
  const result = await observeFleet(f);
  assert.equal(result.identity, 'unconfirmed'); assert.equal(result.leases, 'unconfirmed');
});
test('negative expiration cannot appear as an expired valid lease inventory', async () => {
  const members = leases(); members[0].expiresMs = -1;
  const result = await observeFleet(fixture({ members }));
  assert.equal(result.identity, 'unconfirmed'); assert.equal(result.leases, 'unconfirmed');
});

test('an invalid observation clock cannot classify leases as expired', async () => {
  const f = fixture(); f.now = () => NaN;
  const result = await observeFleet(f);
  assert.equal(result.identity, 'unconfirmed'); assert.equal(result.leases, 'unconfirmed');
});
