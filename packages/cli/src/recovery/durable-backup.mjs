import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hasDurableRuntimeMode, runtimePolicyIdentity, validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { validateRouteSnapshot } from '@fogd/platform/route-snapshot';
import { authorizeInstalledPolicy, verifyRuntimeFamily } from '../runtime/catalog.mjs';
import { durableRuntimeConfig, durablePlanSha256 } from '../runtime/durable-config.mjs';
import { inspectDurableInstallation } from '../runtime/durable-inventory.mjs';
import { assertDurableEnrollmentReady } from '../runtime/enrollment-record.mjs';
import { installationDirectory, assertRuntimeReady } from '../runtime/installation-state.mjs';
import { assertRecoverySourceStopped } from '../runtime/recovery-source.mjs';
import { readDurableStores } from '../runtime/durable-stores.mjs';
import { readPolicyVolume } from '../runtime/policy-volume.mjs';
import { withStoppedDurableInstallation } from '../runtime/durable-stop.mjs';
import { durableSnapshotLayout, durableSnapshotFormat, verifyDurableBundle } from './durable-bundle.mjs';
import { backgroundBackupApps, prepareBackgroundBackup, backgroundSnapshotEvidence } from './background-backup.mjs';
import { fingerprint, writeJson } from './bundle.mjs';
import { snapshotState } from './snapshot-state.mjs';
import { volumeHelper } from './volumes.mjs';
import { docker } from './docker.mjs';

const refused = () => Object.assign(new Error('Durable backup is unconfirmed; retain source storage, operation records and partial snapshot files and inspect background pause and service state'), { code: 'DURABLE_BACKUP_UNCONFIRMED' });
const readState = async (config, policy) => JSON.parse(await volumeHelper(policy.image, config.volumes.controller.name, ['/data/state.json'], { entrypoint: '/bin/cat', capabilities: [] }));
const sameInventory = (before, after) => {
  if (!/^[a-f0-9]{64}$/.test(before?.identity) || before.identity !== after?.identity) throw refused();
};
async function authorizeBackup(selected, io) {
  const { config, entry } = selected, policy = validateRuntimePolicy(selected.policy, config.services.controller.environment);
  if (!hasDurableRuntimeMode(policy) || !isDeepStrictEqual(config, durableRuntimeConfig(config, policy))) throw refused();
  if (!isDeepStrictEqual(await io.authorize(policy), entry)) throw refused();
  await io.ready(config.name); await io.verify(entry); await io.recovery(config.name);
  if (!await io.enrollment(io.directory ?? installationDirectory(config.name), {
    project: config.name, installation: runtimePolicyIdentity(policy), planSha256: durablePlanSha256(config, policy) })) throw refused();
  if (!isDeepStrictEqual(await io.policy(policy.image, config.volumes['runtime-policy'].name, config.services.controller.environment), policy)) throw refused();
  return { config, policy, layout: durableSnapshotLayout(config, policy) };
}
async function archiveVolume(config, policy, name, directory, run) {
  await run(['run', '--pull', 'never', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE',
    '--security-opt', 'no-new-privileges', '--mount', `type=volume,src=${config.volumes[name].name},dst=/data,volume-nocopy,readonly`,
    '--entrypoint', '/bin/tar', policy.image, '--numeric-owner', '-C', '/data', '-cpf', '-', '.'], { output: join(directory, `${name}.tar`) });
}
async function captureStopped(context, before, prepared, directory, io, stopped) {
  const { config, policy, layout } = context, domain = config.services.controller.environment.FOGD_BASE_DOMAIN || 'localhost';
  if (stopped.report.missingVolumes.length || !isDeepStrictEqual(stopped.policy, policy)) throw refused();
  sameInventory(before, await io.inspect(config, policy, { run: io.run }));
  const stores = await io.stores(config, policy), state = await io.state(config, policy);
  const routeAuthority = validateRouteSnapshot(state, { record: stores.authority.record, digest: stores.authority.sha256 }, policy, domain);
  await writeJson(join(directory, 'compose.json'), config);
  for (const name of ['controller', ...layout.archiveVolumes.filter(name => name !== 'controller')]) await archiveVolume(config, policy, name, directory, io.run);
  const images = Object.fromEntries(Object.entries(config.services).map(([name, service]) => [name, service.image]));
  await io.run(['image', 'save', ...new Set(Object.values(images))], { output: join(directory, 'images.tar') });
  const files = {};
  for (const name of layout.archives) files[name] = await fingerprint(join(directory, name));
  const evidence = backgroundSnapshotEvidence(await snapshotState(directory), prepared, Date.now(), policy);
  sameInventory(before, await io.inspect(config, policy, { run: io.run })); await io.recovery(config.name);
  const manifest = { format: durableSnapshotFormat, sourceProject: config.name, stoppedAt: stopped.at,
    completedAt: new Date().toISOString(), durationMs: Date.now() - stopped.started, exits: stopped.report.services,
    images, files, routeAuthority, ...evidence };
  await writeJson(join(directory, 'manifest.json'), manifest);
  await io.verifyBundle(directory, policy);
  return manifest;
}

// Source candidate only. The new archive carries data, never installed policy,
// enrollment grants or host completion records. No legacy restore fallback exists.
export async function backupDurableInstallation(directory, selected, env, options = {}) {
  const io = { authorize: authorizeInstalledPolicy, verify: verifyRuntimeFamily, recovery: assertRecoverySourceStopped,
    enrollment: assertDurableEnrollmentReady, ready: assertRuntimeReady, policy: readPolicyVolume, inspect: inspectDurableInstallation,
    stores: readDurableStores, state: readState, prepare: prepareBackgroundBackup,
    scope: withStoppedDurableInstallation, run: docker, verifyBundle: verifyDurableBundle, ...options };
  try {
    const context = await authorizeBackup(selected, io), { config, policy, layout } = context;
    const before = await io.inspect(config, policy, { run: io.run }), state = await io.state(config, policy);
    backgroundBackupApps(state, policy);
    const destination = resolve(directory); await mkdir(destination, { mode: 0o700 });
    const images = Object.fromEntries(Object.entries(config.services).map(([name, service]) => [name, service.image]));
    const prepared = await io.prepare(env, state, images, layout.replicas, policy), started = Date.now();
    const result = await io.scope(config, stopped => captureStopped(context, before, prepared, destination, io,
      { ...stopped, at: new Date().toISOString(), started }));
    return result.value;
  } catch { throw refused(); }
}
