import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RuntimeIdentity } from '../src/runtime-identity.mjs';
import { fixtureAuthority, signedIdentity } from './fixtures/runtime-proof.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const slot = { id: 'slot-1', prefix: 'slots/one', nodes: ['a', 'b'] };
function fixture() {
  const binary = hash('reviewed-binary'), keys = { a: fixtureAuthority(1), b: fixtureAuthority(2) };
  let nonce = 0;
  const profile = { schema: 2, binarySha256: binary, storage: { endpoint: 'http://storage:9000', region: 'us-east-1' }, bucket: 'fixture', fleets: [{ id: 'slot-1', prefix: 'slots/one',
    nodes: [{ host: 'a', id: 'node-a' }, { host: 'b', id: 'node-b' }] }] };
  const identities = Object.fromEntries(['a', 'b'].map(host => [host, { schema: 2, binarySha256: binary,
    nodeSha256: hash(`node-${host}`), namespaceSha256: hash('s3://fixture/slots/one'),
    storageSha256: hash(JSON.stringify(['s3://fixture/slots/one', 'http://storage:9000', 'us-east-1'])),
    processKeySha256: hash(keys[host].publicKey) }]));
  const members = ['a', 'b'].map(host => ({ key: `node-${host}.json`, node: `node-${host}`, addr: `${host}:8081`, processKey: keys[host].publicKey, expiresMs: 60000 }));
  const calls = [];
  const adapter = { profile, now: () => 1000, challenge: () => (++nonce).toString(16).padStart(64, '0'),
    async identify(host, challenge) { calls.push(host); return signedIdentity(identities[host], challenge, keys[host]); },
    async cliDigest() { calls.push('cli'); return binary; },
    async members() { calls.push('members'); return structuredClone(members); },
  };
  return { profile, identities, members, calls, adapter, get policy() { return new RuntimeIdentity(adapter); } };
}

test('runtime policy verifies the CLI, each native process and stable membership without status commands', async () => {
  const f = fixture(); await f.policy.verify(slot);
  assert.deepEqual(f.calls, ['members', 'cli', 'a', 'b', 'members']);
  f.members.length = 0;
  await assert.rejects(f.policy.verify(slot), { code: 'RUNTIME_IDENTITY_REFUSED' });
  await f.policy.bootstrap(slot);
});

test('binary, node, namespace and exact metadata schema mismatches refuse the fleet', async () => {
  for (const change of [
    f => { f.adapter.cliDigest = async () => hash('older-cli'); },
    f => { f.identities.b.binarySha256 = hash('older-node'); },
    f => { f.identities.b.nodeSha256 = hash('another-node'); },
    f => { f.identities.a.namespaceSha256 = hash('s3://fixture/slots/other'); },
    f => { f.identities.b.schema = 1; },
    f => { f.identities.a.storageSha256 = hash('another-storage'); },
    f => { f.identities.b.processKeySha256 = hash('other-authority'); },
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
    f => { const read = f.adapter.members; let count = 0; f.adapter.members = async () => { const members = await read(); if (++count === 2) members[0].processKey = hash('restarted'); return members; }; },
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
    f => { f.profile.schema = 1; },
    f => { f.profile.binarySha256 = 'unqualified'; },
    f => { f.profile.storage.region = ''; },
    f => { f.profile.storage.endpoint = 'http://user:private@storage'; },
    f => { f.profile.storage.endpoint = 'http://storage?'; },
    f => { f.profile.storage.endpoint = 'http://storage#'; },
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

test('a stable known lease cannot impersonate the process serving metadata', async () => {
  const f = fixture(); f.members[0].processKey = hash('forged-authority');
  await assert.rejects(f.policy.verify(slot), { code: 'RUNTIME_IDENTITY_REFUSED' });
});

test('the same namespace on another endpoint or region is refused', async () => {
  for (const storage of [
    ['s3://fixture/slots/one', 'http://elsewhere:9000', 'us-east-1'],
    ['s3://fixture/slots/one', 'http://storage:9000', 'another-region'],
  ]) {
    const f = fixture(); f.identities.a.storageSha256 = hash(JSON.stringify(storage));
    await assert.rejects(f.policy.verify(slot), { code: 'RUNTIME_IDENTITY_REFUSED' });
  }
});

test('effects require a fresh lease for every expected process while bootstrap permits absent leases', async () => {
  for (const alter of [
    f => { f.members.length = 0; },
    f => { f.members.pop(); },
    f => { f.members[0].expiresMs = 1000; },
    f => { f.members[0].expiresMs = 999; },
    f => { delete f.members[0].expiresMs; },
    f => { f.members[0].expiresMs = -1; },
  ]) {
    const f = fixture(); alter(f);
    await assert.rejects(f.policy.verify(slot), { code: 'RUNTIME_IDENTITY_REFUSED' });
  }
  const bootstrap = fixture(); bootstrap.members.length = 0;
  await bootstrap.policy.bootstrap(slot);
});

test('lease renewal may extend expiry without changing membership authority', async () => {
  const f = fixture(), read = f.adapter.members; let pass = 0;
  f.adapter.members = async () => (await read()).map(member => ({ ...member, expiresMs: ++pass * 60000 }));
  await f.policy.verify(slot);
  assert.deepEqual(f.calls, ['members', 'cli', 'a', 'b', 'members']);
});

test('storage digest matches the native literal vector after origin normalization', async () => {
  const f = fixture(); f.profile.bucket = 'fogd'; f.profile.storage.endpoint = 'HTTP://STORAGE:9000/';
  for (const host of ['a', 'b']) {
    f.identities[host].namespaceSha256 = 'dbbaa9f170901538627c48fad9db58b9339f2fa0245a31ac7d9b625b79050127';
    f.identities[host].storageSha256 = 'de3a0c24af2cc86e0df49a965250cc160629dd18205e4bbbcb651f6ae2ffed2d';
  }
  await f.policy.verify(slot);
  assert.deepEqual(f.calls, ['members', 'cli', 'a', 'b', 'members']);
});

test('bootstrap refuses every present forged, foreign or malformed lease', async () => {
  for (const alter of [
    f => { f.members[0].processKey = f.members[1].processKey; },
    f => { f.members[0].node = 'foreign'; },
    f => { delete f.members[0].expiresMs; },
    f => { const read = f.adapter.members; let pass = 0; f.adapter.members = async () => { const members = await read(); if (++pass === 2) members[0].processKey = members[1].processKey; return members; }; },
  ]) {
    const f = fixture(); alter(f);
    await assert.rejects(f.policy.bootstrap(slot), { code: 'RUNTIME_IDENTITY_REFUSED' });
  }
});

test('bootstrap permits partial valid membership while checking both native authorities', async () => {
  const f = fixture(); f.members.pop();
  await f.policy.bootstrap(slot);
  assert.deepEqual(f.calls, ['members', 'cli', 'a', 'b', 'members']);
});

test('verified process fingerprint ignores lease renewal and ordering but changes on a signed process restart', async () => {
  const f = fixture(), policy = f.policy, first = await policy.verify(slot);
  assert.match(first, /^[a-f0-9]{64}$/);
  f.members.reverse(); f.members.forEach(member => { member.expiresMs += 1000; });
  assert.equal(await policy.verify(slot), first);
  const restarted = fixtureAuthority(9), original = f.adapter.identify;
  f.members.find(member => member.node === 'node-a').processKey = restarted.publicKey;
  f.identities.a.processKeySha256 = hash(restarted.publicKey);
  policy.identify = async (host, challenge) => host === 'a' ? signedIdentity(f.identities.a, challenge, restarted) : original(host, challenge);
  assert.notEqual(await policy.verify(slot), first);
});

test('bootstrap with absent or partial membership never returns a verified fleet fingerprint', async () => {
  const f = fixture(); f.members.pop(); assert.equal(await f.policy.bootstrap(slot), undefined);
  f.members.length = 0; assert.equal(await f.policy.bootstrap(slot), undefined);
});
