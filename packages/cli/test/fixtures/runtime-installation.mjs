import { prebootFixture } from './cron-preboot.mjs';

export function runtimeInstallation() {
  const { source, profile } = prebootFixture();
  source.volumes['runtime-policy'] = { name: `${source.name}_runtime-policy` };
  source.services.controller.volumes.push({ type: 'volume', source: 'runtime-policy', target: '/var/lib/fogd-runtime', read_only: true, volume: { nocopy: true } });
  return { source, profile: { ...profile, family: 'signed-cron-arm64', admission: 'candidate' } };
}
