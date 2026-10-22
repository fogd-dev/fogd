import test from 'node:test';
import assert from 'node:assert/strict';
import { publicProgramPath, validateTransferManifest } from '../src/distribution/manifest.mjs';

const transferFormat = 'fogd-runtime-transfer-v1';
const operatorFiles = ['package.json', 'compose.yaml', '.env.example', 'docs/offline-installation.md'];
const ignoreFiles = ['LICENSE-MIT', 'README.md', 'index.d.ts', 'index.js', 'legacy.js', 'package.json'];
const entry = { id: 'fixture-linux-arm64', sourceFiles: { 'packages/runtime/package.json': 'a'.repeat(64), 'packages/platform/package.json': 'b'.repeat(64) } };
function fixture() {
  const files = {};
  for (const path of [...operatorFiles, 'packages/cli/bin/fogd.js', 'packages/cli/package.json', 'packages/cli/src/runtime/catalog.json', 'packages/cli/src/distribution/bootstrap.mjs', ...ignoreFiles.map(name => `node_modules/ignore/${name}`)]) files[`program/${path}`] = { bytes: 12, sha256: 'c'.repeat(64) };
  for (const [path, sha256] of Object.entries(entry.sourceFiles)) {
    files[`program/${path}`] = { bytes: 12, sha256 };
    files[`program/${path.replace('packages/', 'node_modules/@fogd/')}`] = { bytes: 12, sha256 };
  }
  files['verify-transfer.mjs'] = { ...files['program/packages/cli/src/distribution/bootstrap.mjs'] };
  files['images.tar'] = { bytes: 10240, sha256: 'd'.repeat(64) };
  return { format: transferFormat, runtime: structuredClone(entry), files };
}
test('a qualified source inventory returns an independent manifest value', () => {
  const input = fixture(), value = validateTransferManifest(input, entry);
  assert.deepEqual(value, input);
  value.files['images.tar'].bytes = 1;
  assert.equal(input.files['images.tar'].bytes, 10240);
});
for (const path of ['.env', '.fogd/state.json', 'packages/cli/test/private.mjs', 'packages/cli/src/../secret.mjs', '/packages/cli/src/main.mjs', 'packages/cli/src//main.mjs', 'node_modules/@fogd/cli/src/main.mjs', 'node_modules/ignore/private.env']) {
  test(`private or ambiguous program path is refused: ${path}`, () => assert.equal(publicProgramPath(path), false));
}
for (const [name, change, message] of [
  ['wrong format', m => { m.format = 'fogd-stopped-v1'; }, /manifest/],
  ['different runtime', m => { m.runtime.id = 'different'; }, /manifest/],
  ['extra manifest field', m => { m.credentials = {}; }, /manifest/],
  ['missing image archive', m => { delete m.files['images.tar']; }, /inventory/],
  ['private member', m => { m.files['program/.env'] = { bytes: 0, sha256: 'c'.repeat(64) }; }, /member/],
  ['traversal member', m => { m.files['program/../../secret'] = { bytes: 0, sha256: 'c'.repeat(64) }; }, /member/],
  ['missing operator entrypoint', m => { delete m.files['program/packages/cli/bin/fogd.js']; }, /Required/],
  ['bad fingerprint', m => { m.files['images.tar'].sha256 = 'wrong'; }, /fingerprint/],
  ['negative size', m => { m.files['images.tar'].bytes = -1; }, /fingerprint/],
  ['fractional size', m => { m.files['images.tar'].bytes = 1.5; }, /fingerprint/],
  ['extra fingerprint field', m => { m.files['images.tar'].mode = 'private'; }, /fingerprint/],
  ['wrong canonical source', m => { m.files['program/packages/runtime/package.json'].sha256 = 'e'.repeat(64); }, /fingerprint/],
  ['wrong alias size', m => { m.files['program/node_modules/@fogd/runtime/package.json'].bytes = 100; }, /alias fingerprint/],
  ['extra runtime source', m => { m.files['program/packages/runtime/src/extra.mjs'] = { bytes: 0, sha256: 'c'.repeat(64) }; }, /qualified inventory/],
  ['missing package alias', m => { delete m.files['program/node_modules/@fogd/platform/package.json']; }, /aliases/],
]) test(`manifest refuses ${name}`, () => {
  const input = fixture(); change(input);
  assert.throws(() => validateTransferManifest(input, entry), message);
});
