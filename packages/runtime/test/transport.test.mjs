import test from 'node:test';
import assert from 'node:assert/strict';
import { transportPolicy, validateKeypair, loadTLS } from '../src/transport.mjs';

test('shared profile fails closed without TLS or with legacy credentials', () => {
  assert.deepEqual(transportPolicy({}), { profile: 'local', tls: false });
  assert.deepEqual(transportPolicy({ FOGD_PROFILE: 'shared', FOGD_TLS: '1', FOGD_PUBLIC_BIND_ADDRESS: '0.0.0.0' }), { profile: 'shared', tls: true });
  for (const env of [{ FOGD_PROFILE: 'shared' }, { FOGD_TLS: 'true' }, { FOGD_PROFILE: 'unknown' }, { FOGD_PUBLIC_BIND_ADDRESS: '0.0.0.0' }, { FOGD_PROFILE: 'shared', FOGD_TLS: '1', FOGD_DEPLOY_TOKEN: 'legacy' }]) assert.throws(() => transportPolicy(env));
  assert.throws(() => validateKeypair({ cert: 'private-invalid-cert', key: 'private-invalid-key' }), error => /currently valid PEM/.test(error.message) && !error.message.includes('private-invalid'));
});

test('TLS startup requires installed material only when enabled', async () => {
  const env = { FOGD_TLS_FILE: '/nonexistent/fogd-keypair.json' };
  assert.equal(await loadTLS(env), null);
  await assert.rejects(loadTLS({ ...env, FOGD_TLS: '1' }), /import a certificate/);
});
