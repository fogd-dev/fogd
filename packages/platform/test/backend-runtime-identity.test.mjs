import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { backendRuntimeIdentity } from '../src/backend-runtime-identity.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fogd-identity-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'celld'), bytes = Buffer.from('reviewed executable fixture');
  await writeFile(executable, bytes);
  const profile = { schema: 1, binarySha256: digest(bytes), bucket: 'fixture',
    fleets: [{ id: 'slot-1', prefix: 'slots/one', nodes: [{ host: 'node-a', id: 'stable-node' }] }] };
  const slot = { id: 'slot-1', prefix: 'slots/one', nodes: ['node-a'] };
  const state = { key: 'slots/one/nodes/stable-node.json', node: 'stable-node', addr: 'node-a:8081', truncated: false };
  const calls = [], response = { schema: 1, binarySha256: digest(bytes),
    nodeSha256: digest('stable-node'), namespaceSha256: digest('s3://fixture/slots/one') };
  const backend = { executable, env: { FOGD_BUCKET: 'fixture' }, s3: { async send(command, options) {
    assert.ok(options.abortSignal instanceof AbortSignal);
    calls.push({ operation: command.constructor.name, ...command.input });
    if (command.constructor.name === 'ListObjectsV2Command') return { IsTruncated: state.truncated, Contents: [{ Key: state.key }] };
    if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([JSON.stringify({ node: state.node, addr: state.addr, probe_public_key: 'process-key' })]) };
    throw Error('Unexpected storage mutation');
  } } };
  const transport = { async fetch(url, options) {
    assert.equal(url, 'http://node-a:8082/runtime/identity');
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    return Response.json(response);
  } };
  t.mock.method(globalThis, 'fetch', (...args) => transport.fetch(...args));
  return { slot, backend, profile, state, response, transport, calls, get identity() { return backendRuntimeIdentity(backend, profile); } };
}

test('backend identity reads the configured executable and complete lease inventory without storage writes', async t => {
  const f = await fixture(t);
  await f.identity.verify(f.slot);
  assert.deepEqual(f.calls.map(call => call.operation), ['ListObjectsV2Command', 'GetObjectCommand', 'ListObjectsV2Command', 'GetObjectCommand']);
  assert.ok(f.calls.every(call => call.Bucket === 'fixture'));
  assert.ok(f.calls.filter(call => call.operation === 'ListObjectsV2Command').every(call => call.Prefix === 'slots/one/nodes/'));
  await writeFile(f.backend.executable, 'replaced executable');
  await assert.rejects(f.identity.verify(f.slot), { code: 'RUNTIME_IDENTITY_REFUSED' });
});

test('truncated, foreign or malformed inventories never authorize a matching metadata endpoint', async t => {
  for (const alter of [
    f => { f.state.truncated = true; },
    f => { f.state.key = 'slots/other/nodes/stable-node.json'; },
    f => { f.state.node = 'another-node'; },
    f => { f.state.addr = 'unknown:8081'; },
    f => { f.backend.env.FOGD_BUCKET = 'other'; },
    f => { f.backend.s3.send = async () => { throw Error('private-credential'); }; },
  ]) {
    const f = await fixture(t); alter(f);
    await assert.rejects(f.identity.verify(f.slot), error => error.code === 'RUNTIME_IDENTITY_REFUSED' &&
      !error.message.includes('private-credential') && !JSON.stringify(error).includes('private-credential'));
  }
});

test('HTTP failures, malformed JSON and oversized metadata are refused', async t => {
  for (const response of [
    () => new Response('not found', { status: 404 }),
    () => new Response('invalid-json'),
    f => new Response(JSON.stringify(f.response) + ' '.repeat(2048)),
    () => { throw Error('redirect or timeout'); },
  ]) {
    const f = await fixture(t); f.transport.fetch = async () => response(f);
    await assert.rejects(f.identity.verify(f.slot), { code: 'RUNTIME_IDENTITY_REFUSED' });
  }
});

test('a root namespace inventories native nodes without adding a leading slash', async t => {
  const f = await fixture(t);
  f.slot.prefix = ''; f.profile.fleets[0].prefix = '';
  f.state.key = 'nodes/stable-node.json';
  f.response.namespaceSha256 = digest('s3://fixture/');
  await f.identity.verify(f.slot);
  assert.ok(f.calls.filter(call => call.operation === 'ListObjectsV2Command').every(call => call.Prefix === 'nodes/'));
});

test('a stalled S3 inventory is aborted instead of hanging the serialized caller', async t => {
  const f = await fixture(t); let signal;
  const keepAlive = setTimeout(() => {}, 7000); t.after(() => clearTimeout(keepAlive));
  f.backend.s3.send = async (_command, options) => {
    signal = options.abortSignal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('read aborted')), { once: true }));
  };
  await assert.rejects(f.identity.verify(f.slot), { code: 'RUNTIME_IDENTITY_REFUSED' });
  assert.equal(signal.aborted, true);
});

test('oversized valid lease JSON cannot bypass the bounded inventory reader', async t => {
  const f = await fixture(t), send = f.backend.s3.send;
  f.backend.s3.send = async (command, options) => {
    if (command.constructor.name !== 'GetObjectCommand') return send(command, options);
    return { Body: Readable.from([JSON.stringify({ node: f.state.node, addr: f.state.addr,
      probe_public_key: 'process-key', padding: 'x'.repeat(65536) })]) };
  };
  await assert.rejects(f.identity.verify(f.slot), { code: 'RUNTIME_IDENTITY_REFUSED' });
});

test('a stalled lease body is destroyed at the read deadline', { timeout: 6500 }, async t => {
  const f = await fixture(t), send = f.backend.s3.send, body = new Readable({ read() {} });
  const keepAlive = setTimeout(() => {}, 7000); t.after(() => clearTimeout(keepAlive));
  f.backend.s3.send = async (command, options) => command.constructor.name === 'GetObjectCommand'
    ? { Body: body } : send(command, options);
  await assert.rejects(f.identity.verify(f.slot), { code: 'RUNTIME_IDENTITY_REFUSED' });
  assert.equal(body.destroyed, true);
});
