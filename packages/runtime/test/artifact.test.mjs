import test from 'node:test';
import assert from 'node:assert/strict';
import { translateConfig, inside } from '../src/artifact.mjs';

test('rejects requested unsupported bindings instead of silently dropping them', () => {
  for (const key of ['ai', 'dispatch_namespaces', 'hyperdrive', 'queues', 'services', 'triggers']) {
    assert.throws(() => translateConfig({ [key]: { binding: 'secret' } }, 'hello'), /Unsupported/);
  }
  assert.throws(() => translateConfig({ compatibility_flags: ['future_flag'] }, 'hello'), /flag/);
});
test('translates generated metadata while keeping resource identities stable', () => {
  const input = { name: 'build-name', no_bundle: true, rules: [{ type: 'ESModule' }], d1_databases: [{ binding: 'DB', database_id: 'local' }], r2_buckets: [{ binding: 'STORAGE' }], dispatch_namespaces: [], queues: { producers: [], consumers: [] } };
  const output = translateConfig(input, 'hello');
  assert.equal(output.name, 'hello');
  assert.equal(output.no_bundle, true);
  assert.equal(output.d1_databases[0].database_id, 'hello-db');
  assert.equal(output.r2_buckets[0].bucket_name, 'hello-storage');
  assert.equal(output.rules, undefined);
  assert.deepEqual(output, translateConfig({ ...input, name: 'another-build-name' }, 'hello'));
});
test('rejects paths outside the artifact/project and invalid app names', () => {
  assert.throws(() => inside('/project', '../secret'));
  assert.throws(() => inside('/project', '/secret'));
  assert.throws(() => translateConfig({}, '../app'));
  assert.equal(inside('/project', 'dist/ssr'), '/project/dist/ssr');
});
