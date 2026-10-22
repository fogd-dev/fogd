import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoSecrets, assertArtifactNoSecrets, scanOutputFiles } from './privacy.mjs';

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

test('private values in a retained peer shutdown log cannot pass the output scan', async t => {
  const output = await mkdtemp(join(tmpdir(), 'fogd-private-peer-log-')); t.after(() => rm(output, { recursive: true, force: true }));
  const file = join(output, 'operator.env'), secret = 'application-private-test-value';
  await Promise.all([
    writeFile(file, 'FOGD_ADMIN_PASSWORD=admin-private-test-value\nFOGD_GATEWAY_TOKEN=gateway-private-test-value\n'),
    writeFile(join(output, 'runtime.log'), 'ordinary final shutdown'),
    writeFile(join(output, 'preparation-peer.log'), `peer log contains ${secret}`),
  ]);
  const host = { output, project: 'test', env: { FOGD_ENV_FILE: file }, config: { services: { controller: { environment: { AWS_ACCESS_KEY_ID: 'storage-user-test-value', AWS_SECRET_ACCESS_KEY: 'storage-private-test-value' } } } } };
  await assert.rejects(scanOutputFiles([host], { secret, tokens: { refresh: 'deploy-private-test-value' } }, {}), error => {
    assert.equal(error.message.includes(secret), false); return /Private value appeared/.test(error.message);
  });
});
