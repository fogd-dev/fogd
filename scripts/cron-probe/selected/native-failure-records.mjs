import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { boundedJson } from './native-failure-io.mjs';

const { GetObjectCommand, ListObjectsV2Command } = createRequire('/app/packages/platform/package.json')('@aws-sdk/client-s3');
export async function readFailureRecords(client, policy, fleet) {
  const Bucket = policy.bucket, prefix = fleet.prefix, cell = '.cron:refresh';
  const send = command => client.send(command, { abortSignal: AbortSignal.timeout(5000) });
  const object = async (key, optional = false, limit = 65536) => {
    try { return await boundedJson((await send(new GetObjectCommand({ Bucket, Key: `${prefix}/${key}` }))).Body, limit); }
    catch (error) { if (optional && error.$metadata?.httpStatusCode === 404) return null; throw error; }
  };
  const list = async path => {
    const result = await send(new ListObjectsV2Command({ Bucket, Prefix: `${prefix}/${path}`, MaxKeys: 256 }));
    assert.equal(result.IsTruncated, false, 'Observer inventory is truncated'); return result.Contents || [];
  };
  const [owner, waker, members, publications, leases] = await Promise.all([
    object(`cells/${cell}/own.json`), object('wake/waker.json', true), list('nodes/'), list('wake/entries/'),
    Promise.all(fleet.nodes.map(async node => {
      const lease = await object(`nodes/${node.id}.json`, true);
      if (lease) {
        assert.equal(lease.node, node.id); assert.equal(lease.addr, `${node.host}:8081`); assert.match(lease.probe_public_key, /^[a-f0-9]{64}$/);
        assert.ok(Number.isSafeInteger(lease.expires_ms) && lease.expires_ms >= 0);
      }
      return { expectedNode: node.id, host: node.host, node: lease?.node ?? null, addr: lease?.addr ?? null, publicKey: lease?.probe_public_key ?? null,
        expires_ms: lease?.expires_ms ?? null, missing: lease === null };
    })),
  ]);
  const declared = new Set(fleet.nodes.map(node => `${prefix}/nodes/${node.id}.json`));
  assert.equal(new Set(members.map(row => row.Key)).size, members.length);
  assert.ok(members.every(row => declared.has(row.Key)), 'Undeclared member in selected fleet');
  const ids = fleet.nodes.map(node => node.id);
  // celld writes an empty owner string when releasing its epoch; retain that wire value.
  assert.ok((owner.node === '' || ids.includes(owner.node)) && Number.isSafeInteger(owner.epoch) && owner.epoch >= 0);
  if (waker) assert.ok(ids.includes(waker.node) && Number.isSafeInteger(waker.expires_ms) && waker.expires_ms >= 0);
  const rows = await Promise.all(publications.map(async entry => {
    const row = await object(entry.Key.slice(prefix.length + 1), true, 16384);
    if (row?.cell !== cell) return null;
    const keyLastModifiedMs = entry.LastModified.getTime();
    assert.ok(Number.isSafeInteger(row.due_ms) && row.due_ms >= 0 && Number.isSafeInteger(keyLastModifiedMs));
    return { ...row, key: entry.Key, keyLastModifiedMs };
  }));
  const wakes = rows.filter(Boolean);
  return { owner, waker, leases, wakes, at: Date.now() };
}
