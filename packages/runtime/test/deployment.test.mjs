import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMetadata, deploymentMetadata } from '../src/deployment.mjs';

test('secret declarations preserve only validated non-conflicting names', () => {
  assert.deepEqual(buildMetadata({ secrets: { required: ['TOKEN', 'AUTH_KEY'] } }), { requiredSecrets: ['AUTH_KEY', 'TOKEN'] });
  for (const names of [['TOKEN', 'TOKEN'], ['VITE_TOKEN'], ['vite_token'], ['fogd_token'], ['TOKEN', 'token'], ['__VOID_PROXY_TOKEN'], ['FOGD_ADMIN_PASSWORD'], ['bad-name'], [12], 'TOKEN']) {
    assert.throws(() => buildMetadata({ secrets: { required: names } }));
  }
  for (const config of [{ vars: { TOKEN: 'plaintext' } }, { r2_buckets: [{ binding: 'TOKEN' }] }, { assets: { binding: 'TOKEN' } }]) {
    assert.throws(() => deploymentMetadata({ requiredSecrets: ['TOKEN'] }, config), /conflicts/);
  }
  assert.throws(() => buildMetadata({ secrets: { required: [], values: { TOKEN: 'private' } } }), /Unsupported/);
  assert.throws(() => deploymentMetadata({ requiredSecrets: [], values: {} }, {}), /Invalid/);
});
