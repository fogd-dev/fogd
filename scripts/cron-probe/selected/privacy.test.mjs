import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoSecrets, assertArtifactNoSecrets } from './privacy.mjs';

test('ordinary surfaces reject a private value without exposing it in the failure', () => {
  assert.throws(() => assertNoSecrets(['prefix secret-value suffix'], ['secret-value']), error => {
    assert.equal(error.message.includes('secret-value'), false); return /Private value appeared/.test(error.message);
  });
});
test('missing and empty qualification credentials cannot silently skip the privacy check', () => {
  assert.throws(() => assertNoSecrets(['ordinary status'], [undefined]), /Missing credential/);
  assert.throws(() => assertNoSecrets(['ordinary status'], ['']), /Missing credential/);
});
test('a base64 encoded artifact secret is rejected after decoding its file', () => {
  const artifact = { files: [{ path: 'worker/index.js', data: 'c2VjcmV0LXZhbHVl' }, { path: 'wrangler.json', data: 'e30=' }] };
  assert.throws(() => assertArtifactNoSecrets(artifact, ['secret-value']), /Private value appeared/);
});
test('malformed or incomplete artifact manifests cannot qualify privacy', () => {
  assert.throws(() => assertArtifactNoSecrets({ files: [] }, ['secret-value']), /downloadable artifact/);
  assert.throws(() => assertArtifactNoSecrets({ files: [{ data: 'not base64' }, { data: 'e30=' }] }, ['secret-value']), /encoding is invalid/);
});
test('ordinary text and canonical artifact bytes pass when all private values are absent', () => {
  assert.deepEqual(assertNoSecrets(['ordinary status'], ['secret-value']), { valuesChecked: 1, credentialValuesChecked: 1 });
  assert.deepEqual(assertArtifactNoSecrets({ files: [{ path: 'worker/index.js', data: 'b3JkaW5hcnkgc3RhdHVz' }, { path: 'wrangler.json', data: 'e30=' }] }, ['secret-value']), { valuesChecked: 3, credentialValuesChecked: 1, filesChecked: 2 });
});
