import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeFamily, authorizePolicyEntry, runtimeFamilies, runtimeFamily } from '../src/runtime/catalog.mjs';

const legacyEntry = () => ({ schema: 1, id: 'celld-cron-r1', admission: 'candidate', os: 'linux', architecture: 'arm64',
  image: 'sha256:' + 'a'.repeat(64), storageImage: 'sha256:' + 'b'.repeat(64), parentImage: 'sha256:' + 'e'.repeat(64),
  binarySha256: 'c'.repeat(64), supervisorSha256: 'd'.repeat(64),
  sourceFiles: { 'packages/platform/package.json': 'f'.repeat(64), 'packages/runtime/package.json': '1'.repeat(64) } });
const durableEntry = () => ({ ...legacyEntry(), schema: 2, routing: 'durable' });
const legacyPolicy = () => ({ schema: 2, family: 'celld-cron-r1', admission: 'candidate', image: 'sha256:' + 'a'.repeat(64),
  storageImage: 'sha256:' + 'b'.repeat(64), binarySha256: 'c'.repeat(64), supervisorSha256: 'd'.repeat(64),
  controllerArgs: ['packages/platform/src/main.mjs'], bucket: 'fogd', storage: { endpoint: 'http://minio:9000', region: 'us-east-1' },
  fleets: [
    { id: 'slot-1', prefix: 'slots/slot-1', nodes: [{ host: 'slot-1-a', id: 'slot-1-a' }, { host: 'slot-1-b', id: 'slot-1-b' }] },
    { id: 'slot-2', prefix: 'slots/slot-2', nodes: [{ host: 'slot-2-a', id: 'slot-2-a' }, { host: 'slot-2-b', id: 'slot-2-b' }] },
  ] });
const durablePolicy = () => ({ ...legacyPolicy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'] });

test('shipped catalog still loads and both entry shapes validate', () => {
  assert.ok(runtimeFamilies().length > 0);
  assert.deepEqual(validateRuntimeFamily(legacyEntry()), legacyEntry());
  assert.deepEqual(validateRuntimeFamily(durableEntry()), durableEntry());
});

test('retirement has a separate durable candidate and cannot open ordinary admission or change the v2 protocol', () => {
  const retired = runtimeFamily('celld-durable-v3-linux-arm64', 'enrolled');
  const previous = runtimeFamily('celld-durable-v2-linux-arm64', 'enrolled');
  assert.equal(retired.admission, 'candidate');
  assert.equal(retired.routing, 'durable');
  assert.equal(retired.parentImage, previous.image);
  assert.match(retired.sourceFiles['packages/platform/src/import-retired-routes.mjs'], /^[a-f0-9]{64}$/);
  assert.equal(previous.sourceFiles['packages/platform/src/import-retired-routes.mjs'], undefined);
  assert.equal(retired.binarySha256, previous.binarySha256);
  assert.equal(retired.supervisorSha256, previous.supervisorSha256);
  assert.throws(() => runtimeFamily('celld-durable-v3-linux-arm64'), /ordinary enrollment remains closed/);
});

test('source-built v4 is a separate closed candidate with the migration retry and artifact validation changes', () => {
  const next = runtimeFamily('celld-durable-v4-linux-arm64', 'enrolled');
  const previous = runtimeFamily('celld-durable-v3-linux-arm64', 'enrolled');
  assert.equal(next.admission, 'candidate'); assert.equal(next.schema, 2); assert.equal(next.routing, 'durable');
  assert.notEqual(next.image, previous.image);
  assert.equal(next.storageImage, previous.storageImage);
  assert.equal(next.supervisorSha256, previous.supervisorSha256);
  assert.deepEqual(Object.keys(next.sourceFiles).filter(path => next.sourceFiles[path] !== previous.sourceFiles[path]), [
    'packages/platform/src/activation.mjs', 'packages/platform/src/controller.mjs', 'packages/runtime/src/artifact.mjs',
  ]);
  assert.deepEqual(Object.keys(next.sourceFiles), Object.keys(previous.sourceFiles));
  assert.throws(() => runtimeFamily(next.id), /ordinary enrollment remains closed/);
});

for (const [name, make] of [
  ['legacy entry with routing', () => ({ ...legacyEntry(), routing: 'durable' })],
  ['durable entry without routing', () => { const e = durableEntry(); delete e.routing; return e; }],
  ['durable entry with other routing', () => ({ ...durableEntry(), routing: 'legacy' })],
  ['durable entry with foreign field', () => ({ ...durableEntry(), extra: true })],
  ['durable entry missing source files', () => { const e = durableEntry(); delete e.sourceFiles; return e; }],
  ['string schema', () => ({ ...legacyEntry(), schema: '1' })],
  ['schema 3 entry', () => ({ ...durableEntry(), schema: 3 })],
]) test(`catalog ${name} refuses`, () => {
  assert.throws(() => validateRuntimeFamily(make()), /Invalid shipped runtime family/);
});

test('profile mode binds to matching catalog capability', () => {
  assert.deepEqual(authorizePolicyEntry(legacyPolicy(), legacyEntry()), legacyEntry());
  assert.deepEqual(authorizePolicyEntry(durablePolicy(), durableEntry()), durableEntry());
});

test('browser review runtime is a closed candidate with independent source pins', () => {
  const next = runtimeFamily('celld-approval-v6-linux-arm64', 'candidate');
  const previous = runtimeFamily('celld-durable-v5-linux-arm64');
  assert.equal(next.admission, 'candidate');
  assert.equal(next.routing, 'durable');
  assert.equal(next.parentImage, previous.image);
  assert.notEqual(next.image, previous.image);
  for (const key of ['storageImage', 'binarySha256', 'supervisorSha256']) assert.equal(next[key], previous[key]);
  for (const name of ['admin-review', 'review-artifact', 'decision-history']) {
    assert.match(next.sourceFiles[`packages/platform/src/${name}.mjs`], /^[a-f0-9]{64}$/);
  }
  assert.equal(previous.sourceFiles['packages/platform/src/admin-review.mjs'], undefined);
  assert.throws(() => runtimeFamily(next.id), /ordinary enrollment remains closed/);
  assert.deepEqual(runtimeFamily(previous.id), previous);
});

test('v7 matches the shared reader export while preserving v6 program bodies and closed admission', () => {
  const next = runtimeFamily('celld-approval-v7-linux-arm64', 'candidate');
  const previous = runtimeFamily('celld-approval-v6-linux-arm64', 'candidate');
  assert.equal(next.parentImage, previous.image);
  assert.equal(next.admission, 'candidate');
  assert.deepEqual(Object.keys(next.sourceFiles).filter(path => next.sourceFiles[path] !== previous.sourceFiles[path]), ['packages/platform/package.json']);
  for (const key of ['storageImage', 'binarySha256', 'supervisorSha256']) assert.equal(next[key], previous[key]);
  assert.throws(() => runtimeFamily(next.id), /ordinary enrollment remains closed/);
});

test('cross-mode and mismatched authorization refuses', () => {
  const differs = /differs from the shipped catalog/;
  assert.throws(() => authorizePolicyEntry(durablePolicy(), legacyEntry()), differs);
  assert.throws(() => authorizePolicyEntry(legacyPolicy(), durableEntry()), differs);
  assert.throws(() => authorizePolicyEntry(durablePolicy(), { ...durableEntry(), id: 'other-family' }), differs);
  assert.throws(() => authorizePolicyEntry(durablePolicy(), { ...durableEntry(), image: 'sha256:' + '9'.repeat(64) }), differs);
  assert.throws(() => authorizePolicyEntry({ ...durablePolicy(), routing: 'legacy' }, durableEntry()), { code: 'RUNTIME_POLICY_REFUSED' });
  assert.throws(() => authorizePolicyEntry(durablePolicy(), { ...durableEntry(), routing: 'legacy' }), /Invalid shipped runtime family/);
});

test('v8 fixes terminal artifact retention with explicit admission and unchanged native pins', () => {
  const next = runtimeFamily('celld-approval-v8-linux-arm64', 'enrolled');
  const previous = runtimeFamily('celld-approval-v7-linux-arm64', 'enrolled');
  assert.equal(next.admission, 'qualified'); assert.equal(next.routing, 'durable');
  assert.equal(next.parentImage, previous.image); assert.notEqual(next.image, previous.image);
  assert.deepEqual(Object.keys(next.sourceFiles).filter(path => next.sourceFiles[path] !== previous.sourceFiles[path]), ['packages/platform/src/artifact-retention.mjs']);
  for (const key of ['storageImage', 'binarySha256', 'supervisorSha256']) assert.equal(next[key], previous[key]);
  assert.deepEqual(runtimeFamily(next.id), next);
});
