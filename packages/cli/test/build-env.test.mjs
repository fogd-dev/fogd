import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEnvironment } from '../src/build-env.mjs';

test('app builds omit deployment credentials and managed Cloudflare build flags', () => {
  const env = { PATH: '/tools', APP_LABEL: 'demo', CLOUDFLARE_API_TOKEN: 'fake', CF_ACCOUNT_ID: 'fake', AWS_SECRET_ACCESS_KEY: 'fake', MINIO_ROOT_PASSWORD: 'fake', VOID_DEPLOY_PROJECT_ID: 'fake', VOID_CLOUDFLARE_DEPLOY_BUILD: '1', VOID_MANAGED: '1', FOGD_ADMIN_TOKEN: 'fake', FOGD_BUCKET_PASSWORD: 'fake', FOGD_APP_SECRET: 'fake' };
  assert.deepEqual(buildEnvironment(env), { PATH: '/tools', APP_LABEL: 'demo' });
  assert.equal(env.VOID_MANAGED, '1');
});
