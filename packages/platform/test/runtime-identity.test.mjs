import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RuntimeIdentity } from '../src/runtime-identity.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const slot = { id: 'slot-1', prefix: 'slots/one', nodes: ['a', 'b'] };
function fixture() {
  const binary = hash('reviewed-binary');
  const profile = { schema: 1, binarySha256: binary, bucket: 'fixture', fleets: [{ id: 'slot-1', prefix: 'slots/one',
    nodes: [{ host: 'a', id: 'node-a' }, { host: 'b', id: 'node-b' }] }] };
  const identities = Object.fromEntries(['a', 'b'].map(host => [host, { schema: 1, binarySha256: binary,
    nodeSha256: hash(`node-${host}`), namespaceSha256: hash('s3://fixture/slots/one') }]));
  const members = ['a', 'b'].map(host => ({ key: `node-${host}.json`, node: `node-${host}`, addr: `${host}:8081`, processKey: `process-${host}` }));
  const calls = [];
  const adapter = { profile,
    async identify(host) { calls.push(host); return identities[host]; },
    async cliDigest() { calls.push('cli'); return binary; },
    async members() { calls.push('members'); return structuredClone(members); },
  };
  return { profile, identities, members, calls, adapter, get policy() { return new RuntimeIdentity(adapter); } };
}

test('runtime policy verifies the CLI, each native process and stable membership without status commands', async () => {
  const f = fixture(); await f.policy.verify(slot);
  assert.deepEqual(f.calls, ['members', 'cli', 'a', 'b', 'members']);
  f.members.length = 0;
  await f.policy.verify(slot); // Before bootstrap, no leases exist yet.
});

test('binary, node, namespace and exact metadata schema mismatches refuse the fleet', async () => {
  for (const change of [
    f => { f.adapter.cliDigest = async () => hash('older-cli'); },
    f => { f.identities.b.binarySha256 = hash('older-node'); },
    f => { f.identities.b.nodeSha256 = hash('another-node'); },
    f => { f.identities.a.namespaceSha256 = hash('s3://fixture/slots/other'); },
    f => { f.identities.b.schema = 2; },
    f => { f.identities.a.privateCredential = 'private-sentinel'; },
    f => { f.adapter.identify = async () => { throw Error('private-sentinel'); }; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.policy.verify(slot), error => error.code === 'RUNTIME_IDENTITY_REFUSED' &&
      !JSON.stringify(error).includes('private-sentinel') && !error.message.includes('private-sentinel'));
  }
});

test('foreign, duplicated, malformed or redirected lease identities are refused, even when replicas match', async () => {
  for (const change of [
    f => { f.members.push({ key: 'old.json', node: 'old', addr: 'old:8081' }); },
    f => { f.members.push({ ...f.members[0] }); },
    f => { f.members[0].key = 'different.json'; },
    f => { f.members[0].addr = 'elsewhere:8081'; },
    f => { f.members[0].node = 'unknown'; },
    f => { f.members[0].processKey = ''; },
    f => { const read = f.adapter.members; let count = 0; f.adapter.members = async () => { const members = await read(); if (++count === 2) members[0].processKey = 'restarted'; return members; }; },
    f => { f.members[0] = null; },
    f => { f.adapter.members = async () => null; },
    f => { let count = 0; const members = f.adapter.members; f.adapter.members = async () => ++count === 1 ? [] : members(); },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.policy.verify(slot), { code: 'RUNTIME_IDENTITY_REFUSED' });
  }
});

test('invalid profiles or changed slot identity refuse before any inspection', async () => {
  for (const change of [
    f => { f.profile.schema = 2; },
    f => { f.profile.binarySha256 = 'unqualified'; },
    f => { f.profile.fleets.push(structuredClone(f.profile.fleets[0])); },
    f => { f.profile.fleets[0].prefix = 'slots//one'; },
    f => { f.profile.fleets[0].nodes[1].id = 'node-a'; },
    f => { f.profile.fleets[0].nodes[1].host = 'a'; },
    f => { f.profile.fleets[0].nodes[0].host = 'a/../../other'; },
    f => { f.profile.fleets[0].nodes[0].id = 'node/a'; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.policy.verify(slot), { code: 'RUNTIME_IDENTITY_REFUSED' });
    assert.deepEqual(f.calls, []);
  }
  for (const changed of [{ ...slot, id: 'other' }, { ...slot, prefix: 'other' }, { ...slot, nodes: ['a'] }, { ...slot, nodes: ['a', 'a'] }]) {
    const f = fixture(); await assert.rejects(f.policy.verify(changed), { code: 'RUNTIME_IDENTITY_REFUSED' });
    assert.deepEqual(f.calls, []);
  }
});

test('policy snapshots its expected profile and repeats observations without cached authorization', async () => {
  const f = fixture(), policy = f.policy;
  f.profile.binarySha256 = hash('changed-profile');
  await policy.verify(slot);
  f.identities.b.binarySha256 = hash('runtime-replaced');
  await assert.rejects(policy.verify(slot), { code: 'RUNTIME_IDENTITY_REFUSED' });
  assert.equal(f.calls.filter(call => call === 'b').length, 2);
});
