import test from 'node:test';
import assert from 'node:assert/strict';
import { readLogOwner } from '../src/logs/owner-worker.mjs';
import { Backend } from '../../platform/src/backend.mjs';
import { validateRuntimePolicy } from '../../platform/src/runtime-policy.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

function fixture(response = { app: 'sample', private: 'private-owner-data' }) {
  const f = prebootFixture(), calls = [], constructors = [];
  const input = { env: f.source.services.controller.environment, profile: { ...f.profile, family: 'log-test', admission: 'qualified' }, expected: { app: 'sample', slot: 'slot-1' }, address: '172.20.0.20' };
  class OwnerBackend extends Backend {
    constructor(env) {
      super(env); constructors.push(env);
      this.s3 = { send: async command => { calls.push({ operation: command.constructor.name, input: command.input }); if (response instanceof Error) throw response; return { Body: { transformToString: async () => JSON.stringify(response) } }; } };
    }
  }
  return { input, calls, constructors, run: (value = input) => readLogOwner(value, { Backend: OwnerBackend, validateRuntimePolicy }) };
}

test('the real owner reader requests only the selected prefix through the inspected storage address', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { owner: 'matched' });
  assert.deepEqual(f.calls, [{ operation: 'GetObjectCommand', input: { Bucket: 'fogd', Key: 'slots/slot-1/fogd-owner.json' } }]);
  assert.equal(f.constructors[0].S3_ENDPOINT, 'http://172.20.0.20:9000');
});

for (const response of [{ app: 'another-app', private: 'private-owner-data' }, {}, null, new Error('private-storage-error')]) test('unknown ownership or storage failure stays unconfirmed without private output', async () => {
  const f = fixture(response);
  assert.deepEqual(await f.run(), { owner: 'unconfirmed' });
});

for (const change of [
  { address: 'other-host' }, { expected: { app: '', slot: 'slot-1' } }, { expected: { slot: 'slot-1' } }, { expected: { app: 'sample', slot: 'unknown' } },
]) test(`unverified ownership input causes no storage request: ${JSON.stringify(change)}`, async () => {
  const f = fixture(); assert.deepEqual(await f.run({ ...f.input, ...change }), { owner: 'unconfirmed' });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.constructors, []);
});

test('a changed fleet prefix refuses before a storage request', async () => {
  const f = fixture(), env = { ...f.input.env }, slots = JSON.parse(env.FOGD_SLOTS); slots[0].prefix = 'slots/other'; env.FOGD_SLOTS = JSON.stringify(slots);
  assert.deepEqual(await f.run({ ...f.input, env }), { owner: 'unconfirmed' }); assert.deepEqual(f.calls, []);
});

test('a valid numeric-leading app name is matched without changing its identity', async () => {
  const f = fixture({ app: '1-demo' });
  assert.deepEqual(await f.run({ ...f.input, expected: { app: '1-demo', slot: 'slot-1' } }), { owner: 'matched' });
});
