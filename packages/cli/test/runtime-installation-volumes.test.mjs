import test from 'node:test';
import assert from 'node:assert/strict';
import { installationVolumeNames } from '../src/runtime/installation-volumes.mjs';
import { durableFixture } from './fixtures/durable-bundle.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

test('exclusion covers durable authority and enrollment roles plus every later declared volume', () => {
  const { config } = durableFixture(); config.volumes['later-data'] = { name: 'original_later-data' };
  assert.deepEqual(installationVolumeNames(config), Object.values(config.volumes).map(volume => volume.name));
  for (const role of ['route-authority', 'gateway-policy', 'route-enrollment', 'runtime-policy', 'controller', 'slot-2-b']) {
    const missing = structuredClone(config); delete missing.volumes[role];
    assert.throws(() => installationVolumeNames(missing), /Cannot verify related installation volumes/);
  }
});
test('legacy layouts retain their required roles while malformed or aliased metadata refuses', () => {
  const { source } = prebootFixture(); assert.deepEqual(installationVolumeNames(source), Object.values(source.volumes).map(volume => volume.name));
  for (const mutate of [config => { config.volumes = {}; }, config => { delete config.volumes['slot-1-a']; },
    config => { config.volumes.controller.name = config.volumes.bucket.name; }, config => { config.volumes.bucket.name = 'bad,name'; }]) {
    const value = structuredClone(source); mutate(value); assert.throws(() => installationVolumeNames(value), /Cannot verify related installation volumes/);
  }
});
