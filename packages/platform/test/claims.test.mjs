import test from 'node:test';
import assert from 'node:assert/strict';
import { Backend } from '../src/backend.mjs';
import { validateRetirementState } from '../src/retirement.mjs';
import { claimCapability } from '../src/claims.mjs';

function bucket(owner = null, deployed = false) {
  const backend = new Backend({ FOGD_BUCKET: 'fixture' }), calls = [];
  backend.s3 = { async send(command) {
    const verb = command.constructor.name; calls.push({ verb, input: command.input });
    if (verb === 'GetObjectCommand') {
      if (!owner) throw { $metadata: { httpStatusCode: 404 } };
      return { Body: { async transformToString() { return JSON.stringify(owner); } } };
    }
    if (verb === 'ListObjectsV2Command') return { KeyCount: deployed ? 1 : 0 };
    if (verb === 'PutObjectCommand') {
      assert.equal(command.input.IfNoneMatch, '*');
      owner = JSON.parse(command.input.Body); return {};
    }
    throw Error('Unexpected bucket operation');
  } };
  return { backend, calls };
}
test('unresolved ownership refuses published fleets, including a matching existing owner', async () => {
  for (const owner of [null, { app: 'hello' }]) {
    const f = bucket(owner, true);
    await assert.rejects(f.backend.claim({ prefix: 'fleet' }, 'hello', { unpublished: true }), /contains a deployment/);
    assert.ok(!f.calls.some(c => c.verb === 'PutObjectCommand'));
    assert.equal(f.calls.at(-1).input.Prefix, 'fleet/deploy/');
  }
});
test('claim retry is idempotent, verifies no publication, and never replaces a foreign owner', async () => {
  const f = bucket();
  await f.backend.claim({ prefix: 'fleet' }, 'hello', { unpublished: true });
  await f.backend.claim({ prefix: 'fleet' }, 'hello', { unpublished: true });
  assert.equal(f.calls.filter(c => c.verb === 'PutObjectCommand').length, 1);
  assert.equal(f.calls.filter(c => c.verb === 'ListObjectsV2Command').length, 2);
  await assert.rejects(f.backend.claim({ prefix: 'fleet' }, 'other', { unpublished: true }), /owner mismatch/);
  const active = bucket({ app: 'hello' }, true);
  await active.backend.claim({ prefix: 'fleet' }, 'hello');
  assert.deepEqual(active.calls.map(c => c.verb), ['GetObjectCommand']);
});
test('claim intent declares a required controller-state capability', () => {
  assert.doesNotThrow(() => validateRetirementState({ requirements: [claimCapability], apps: {} }, []));
  assert.throws(() => validateRetirementState({ requirements: ['unknown-platform-state'], apps: {} }, []), /unsupported platform capability/);
});
test('reservation release requires an empty unowned fleet and performs no bucket mutation', async () => {
  for (const [owner, deployed] of [[{ app: 'hello' }, false], [null, true]]) {
    const f = bucket(owner, deployed);
    await assert.rejects(f.backend.assertUnclaimed({ prefix: 'fleet' }));
    assert.ok(!f.calls.some(c => c.verb === 'PutObjectCommand'));
  }
  const empty = bucket(); await empty.backend.assertUnclaimed({ prefix: 'fleet' });
  assert.deepEqual(empty.calls.map(c => c.verb), ['GetObjectCommand', 'ListObjectsV2Command']);
});
test('a conditional ownership create conflict only accepts the same app', async () => {
  for (const winner of ['hello', 'foreign']) {
    const f = bucket(); let owner = null;
    f.backend.owner = async () => owner;
    f.backend.s3 = { async send(command) {
      if (command.constructor.name === 'ListObjectsV2Command') return { KeyCount: 0 };
      assert.equal(command.input.IfNoneMatch, '*'); owner = { app: winner };
      throw { $metadata: { httpStatusCode: 412 } };
    } };
    const claim = f.backend.claim({ prefix: 'fleet' }, 'hello', { unpublished: true });
    if (winner === 'hello') await claim;
    else await assert.rejects(claim, /owner mismatch/);
  }
});
