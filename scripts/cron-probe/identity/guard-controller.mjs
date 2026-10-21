// Explicit private profile; ordinary artifact admission remains closed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('/app/packages/platform/src/backend.mjs');
const { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
import { Backend } from '/app/packages/platform/src/backend.mjs';
import { backendCronRuntime } from '/app/packages/platform/src/backend-runtime-identity.mjs';

const binarySha256 = process.argv[2]; assert.match(binarySha256, /^[a-f0-9]{64}$/);
const backend = new Backend(), calls = [], run = backend.run.bind(backend);
backend.run = async (slot, args) => { calls.push(args[0] === 'cron' ? `cron:${args[1]}` : args[0]); return run(slot, args); };
const slot = { id: 'slot-1', prefix: 'slots/one', nodes: ['a', 'b'] };
const profile = { schema: 1, binarySha256, bucket: process.env.FOGD_BUCKET,
  fleets: [{ ...slot, nodes: slot.nodes.map(host => ({ host, id: host })) }] };
const artifact = await mkdtemp('/tmp/fogd-identity-artifact-');
await writeFile(join(artifact, 'wrangler.json'), JSON.stringify({ compatibility_date: '2026-01-01' }));
const resources = { script: 'identity-guard', d1: [], crons: ['* * * * *'] };
const before = await snapshot(), refused = [];
for (const [name, alter] of [
  ['cli', candidate => { candidate.binarySha256 = '0'.repeat(64); }],
  ['node', candidate => { candidate.fleets[0].nodes[1].id = 'different-node'; }],
  ['namespace', candidate => { candidate.fleets[0].prefix = 'slots/another'; }],
  ['older-process', candidate => { candidate.fleets[0].nodes[1] = { host: 'older', id: 'older' }; }],
]) {
  const candidate = structuredClone(profile); alter(candidate);
  const selected = { ...slot, prefix: candidate.fleets[0].prefix, nodes: candidate.fleets[0].nodes.map(node => node.host) };
  backend.crons = backendCronRuntime(backend, candidate);
  await assert.rejects(backend.bootstrap(selected, artifact, resources), { code: 'CRON_RUNTIME_UNVERIFIED' });
  await assert.rejects(backend.crons.status(selected, resources.script), { code: 'CRON_RUNTIME_UNVERIFIED' });
  assert.deepEqual(calls, []); refused.push(name);
}
const Key = `${slot.prefix}/nodes/foreign.json`, Bucket = profile.bucket;
await backend.s3.send(new PutObjectCommand({ Bucket, Key,
  Body: JSON.stringify({ node: 'foreign', addr: 'older:8081', expires_ms: 0, probe_public_key: 'foreign-process' }) }));
try {
  backend.crons = backendCronRuntime(backend, profile);
  await assert.rejects(backend.bootstrap(slot, artifact, resources), { code: 'CRON_RUNTIME_UNVERIFIED' });
  await assert.rejects(backend.crons.status(slot, resources.script), { code: 'CRON_RUNTIME_UNVERIFIED' });
  assert.deepEqual(calls, []); refused.push('expired-foreign-lease');
} finally { await backend.s3.send(new DeleteObjectCommand({ Bucket, Key })); }
const after = await snapshot(); assert.deepEqual(after, before);
backend.crons = backendCronRuntime(backend, profile);
const verified = backend.crons.verify;
backend.crons.verify = async selected => { await verified(selected); calls.push('verified'); };
const version = await backend.bootstrap(slot, artifact, resources);
await backend.ready(slot, version);
const leaseInventory = await leases();
assert.deepEqual(leaseInventory.map(row => ({ key: row.key, node: row.node, addr: row.addr })),
  ['a', 'b'].map(node => ({ key: `${node}.json`, node, addr: `${node}:8081` })));
assert.ok(leaseInventory.every(row => /^[a-f0-9]{64}$/.test(row.processKeySha256)));
await backend.s3.send(new PutObjectCommand({ Bucket, Key,
  Body: JSON.stringify({ node: 'foreign', addr: 'older:8081', expires_ms: 0, probe_public_key: 'foreign-process' }) }));
try {
  await assert.rejects(backend.crons.status(slot, resources.script), { code: 'CRON_RUNTIME_UNVERIFIED' });
  assert.deepEqual(calls, ['verified', 'deploy']);
} finally { await backend.s3.send(new DeleteObjectCommand({ Bucket, Key })); }
const held = await backend.crons.status(slot, resources.script);
assert.deepEqual(held, { paused: true, revision: 0, nextAlarm: null, crons: [] });
const paused = await backend.crons.pause(slot, resources.script); assert.deepEqual(paused, held);
await assert.rejects(backend.crons.resume(slot, resources.script, version), { code: 'CRON_EMPTY_SCHEDULE' });
assert.deepEqual(calls, ['verified', 'deploy', 'verified', 'cron:info', 'verified', 'cron:pause', 'verified', 'cron:info', 'verified', 'cron:info']);
const finalLeaseInventory = await leases(); assert.deepEqual(finalLeaseInventory, leaseInventory);
console.log(JSON.stringify({ refused, before, after, calls, version, held, paused, leaseInventory, finalLeaseInventory, postBootstrapForeignLeaseRefused: true,
  replicas: await Promise.all(slot.nodes.map(async node => ({ node, ...await backend.deployment(node) }))),
  scope: 'Candidate profile only: refuses bootstrap and info before any CLI call; then guarded app-free bootstrap and empty held cron controls. No scheduled application or ordinary admission qualification.' }));

async function snapshot() {
  const Bucket = profile.bucket;
  const listing = await backend.s3.send(new ListObjectsV2Command({ Bucket }));
  assert.equal(Boolean(listing.IsTruncated), false);
  return Promise.all((listing.Contents || []).map(async ({ Key }) => {
    const object = await backend.s3.send(new GetObjectCommand({ Bucket, Key }));
    return { key: Key, sha256: createHash('sha256').update(await object.Body.transformToByteArray()).digest('hex') };
  }));
}

async function leases() {
  const Bucket = profile.bucket, Prefix = `${slot.prefix}/nodes/`;
  const listing = await backend.s3.send(new ListObjectsV2Command({ Bucket, Prefix }));
  assert.equal(Boolean(listing.IsTruncated), false);
  return Promise.all((listing.Contents || []).map(async ({ Key }) => {
    const object = await backend.s3.send(new GetObjectCommand({ Bucket, Key }));
    const value = JSON.parse(await object.Body.transformToString());
    assert.equal(typeof value.probe_public_key, 'string'); assert.ok(value.probe_public_key.length);
    return { key: Key.slice(Prefix.length), node: value.node, addr: value.addr,
      processKeySha256: createHash('sha256').update(value.probe_public_key).digest('hex') };
  }));
}
