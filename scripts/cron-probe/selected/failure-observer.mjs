import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runtimePolicyIdentity } from '../../../packages/platform/src/runtime-policy.mjs';
import { observerEnvironment, observerOptions } from './observer-container.mjs';

const prefix = '/app/scripts/cron-probe/selected/';
const programs = ['native-failure-observer.mjs', 'native-failure-io.mjs', 'native-failure-records.mjs', 'failure-authority.mjs'];
const bucketModes = new Set(['post-cut', 'quiet-wake', 'prepare-waker']);
export async function failureObserver(host, active, channel = 'native') {
  assert.ok(['native', 'storage'].includes(channel));
  const fleet = host.policy.fleets.find(value => value.id === active.slot); assert.ok(fleet);
  const network = channel === 'storage' ? 'control' : `fleet-${host.policy.fleets.indexOf(fleet) + 1}`;
  const name = `fogd-failure-reader-${randomBytes(8).toString('hex')}`, mounts = [], sources = {};
  for (const name of programs) {
    const path = fileURLToPath(new URL(name, import.meta.url));
    sources[`scripts/cron-probe/selected/${name}`] = createHash('sha256').update(await readFile(path)).digest('hex');
    mounts.push('--mount', `type=bind,src=${path},dst=${prefix}${name},readonly`);
  }
  let id;
  try {
    id = (await host.run('docker', ['run', '-d', '--rm', '--name', name, ...observerOptions(host, host.config.networks[network].name), ...mounts,
      '--entrypoint', '/usr/local/bin/node', host.entry.image, '-e', 'setInterval(()=>{},60000)'])).trim();
    assert.match(id, /^[a-f0-9]{64}$/);
    const [container] = JSON.parse(await host.run('docker', ['inspect', id]));
    assert.equal(container.Image, host.entry.image); assert.equal(container.State.Running, true); assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.equal(container.Config.Labels['fogd.qualifier.project'], host.project);
    assert.equal(container.RestartCount, 0); assert.equal(container.State.OOMKilled, false);
    assert.equal(Object.keys(container.NetworkSettings.Networks).length, 1); assert.ok(container.NetworkSettings.Networks[host.config.networks[network].name]);
    assert.ok(container.Mounts.filter(mount => mount.Type !== 'tmpfs').every(mount => mount.RW === false));
    assert.deepEqual(container.HostConfig.CapDrop, ['ALL']); assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges'));
    const inspect = { id, name, image: container.Image, network: host.config.networks[network].name, channel, sources };
    return {
      inspect,
      async observe(mode, options = {}) {
        assert.ok(['verify-both', 'pre-cut', 'post-cut', 'verify-survivor', 'recovery', 'quiet-wake', 'first-read', 'guard-refusal', 'prepare-waker', 'prepared-state'].includes(mode));
        assert.ok(Object.keys(options).every(key => ['time', 'keys', 'absentId'].includes(key)));
        assert.equal(bucketModes.has(mode), channel === 'storage', 'Observation mode has the wrong network channel');
        host.access?.({ kind: bucketModes.has(mode) ? 'bucket-only' : 'native', slot: active.slot, mode });
        const input = { env: observerEnvironment(host), slotId: active.slot, deployment: active.id, digest: active.digest, version: active.version, mode, ...options };
        const result = JSON.parse(await host.run('docker', ['exec', '-i', id, '/usr/local/bin/node', `${prefix}native-failure-observer.mjs`], { inputText: JSON.stringify(input), timeout: 30000 }));
        assert.equal(result.policyIdentity, runtimePolicyIdentity(host.policy)); assert.match(result.stateSha256, /^[a-f0-9]{64}$/);
        return result;
      },
      async close() { await host.run('docker', ['rm', '-f', id]); },
    };
  } catch (error) {
    if (id) { try { await host.run('docker', ['rm', '-f', id]); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Failure observer setup and cleanup failed'); } }
    throw error;
  }
}
