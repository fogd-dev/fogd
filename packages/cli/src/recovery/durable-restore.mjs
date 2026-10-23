import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve, dirname, basename, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { readDurableRestorePlan } from '../runtime/durable-recovery-plan.mjs';
import { enrollDurableRestoration } from '../runtime/durable-installation.mjs';
import { restoreDurableRoutes } from '../runtime/durable-restoration.mjs';
import { verifyRuntimeFamily } from '../runtime/catalog.mjs';
import { acquireStopFence } from '../runtime/launch-fence.mjs';
import { hasRuntimeEnrollment, installationDirectory } from '../runtime/installation-state.mjs';
import { assertRecoverySourceStopped, writeRecoverySource } from '../runtime/recovery-source.mjs';
import { readPolicyVolume } from '../runtime/policy-volume.mjs';
import { restoreDurableData } from './durable-restore-data.mjs';
import { verifyDurableBundle, durableSnapshotFormat } from './durable-bundle.mjs';
import { fingerprint, writeJson, composeLiteral } from './bundle.mjs';
import { stopped } from './docker.mjs';

const refused = () => Object.assign(new Error('Durable restore is unconfirmed; keep source and destination stopped and retain source data, destination enrollment and partial output'), { code: 'DURABLE_RESTORE_UNCONFIRMED' });
const volumeNames = config => Object.values(config.volumes).map(volume => volume.name);
async function restorePaths(directory, output) {
  const source = await realpath(resolve(directory)), requested = resolve(output);
  const destination = join(await realpath(dirname(requested)), basename(requested)), path = relative(source, destination);
  if (!path || path !== '..' && !path.startsWith('..' + sep)) throw refused();
  return { source, destination };
}
async function sourceStopped(plan, io) {
  await io.related(plan.source.config.name);
  await io.stopped(plan.source.config.name, volumeNames(plan.source.config));
}
async function sourceSnapshot(directory, plan, io) {
  const checked = await io.bundle(directory, plan.source.policy);
  if ((await fingerprint(join(directory, 'manifest.json'))).sha256 !== plan.snapshot ||
    !isDeepStrictEqual(checked.config, plan.source.config) || !isDeepStrictEqual(checked.state, plan.source.state) || !isDeepStrictEqual(checked.authority, plan.source.authority)) throw refused();
}
async function populate(directory, output, plan, context, io) {
  const { config, policy, inventory } = context;
  await sourceStopped(plan, io); await sourceSnapshot(directory, plan, io);
  await io.data(directory, config, policy);
  await sourceStopped(plan, io); await sourceSnapshot(directory, plan, io);
  const receipt = await io.routes(config, { profile: policy, sourceProfile: plan.source.policy,
    source: { state: plan.source.state, authority: plan.source.authority }, binding: inventory.identity, snapshot: plan.snapshot, domain: plan.domain });
  if (!isDeepStrictEqual(await io.policy(policy.image, config.volumes['runtime-policy'].name, config.services.controller.environment), policy)) throw refused();
  await sourceStopped(plan, io); await io.related(config.name);
  await writeJson(join(output, 'compose.json'), composeLiteral(config));
  await writeJson(join(output, 'restored.json'), { format: durableSnapshotFormat, sourceProject: plan.source.config.name,
    project: config.name, snapshot: plan.snapshot, runtimeFamily: policy.family, identitySha256: runtimePolicyIdentity(policy),
    preparedAt: new Date().toISOString(), enrollmentRequired: true, services: 'stopped', httpRouting: 'withheld', routeAuthoritySha256: receipt.sha256 });
  return receipt;
}

// New-format snapshots are data only. The enrollment coordinator independently
// verifies and installs policies, allocates stopped resources and withholds its
// completion record until copying, route rebinding and readbacks all finish.
export async function restoreDurableInstallation(directory, project, output, selection, options = {}) {
  const io = { plan: readDurableRestorePlan, verify: verifyRuntimeFamily, enrolled: hasRuntimeEnrollment,
    directory: installationDirectory, acquire: acquireStopFence, related: assertRecoverySourceStopped, stopped,
    relation: writeRecoverySource, enroll: enrollDurableRestoration, data: restoreDurableData,
    routes: restoreDurableRoutes, policy: readPolicyVolume, bundle: verifyDurableBundle, ...options };
  let fence, releasing = false;
  try {
    const { source, destination } = await restorePaths(directory, output), plan = await io.plan(source, project, selection);
    await io.verify(plan.entry); await sourceStopped(plan, io);
    if (await io.enrolled(plan.source.config.name)) fence = await io.acquire(io.directory(plan.source.config.name), {
      project: plan.source.config.name, installation: runtimePolicyIdentity(plan.source.policy) });
    await sourceStopped(plan, io);
    await mkdir(destination, { mode: 0o700 });
    const selected = { ...plan.target, entry: plan.entry };
    const tasks = {
      prepare: async ({ config }) => { await io.relation(config.name, plan.source.config.name, plan.source.config); await sourceStopped(plan, io); await io.related(config.name); },
      populate: context => populate(source, destination, plan, context, io),
    };
    const result = await io.enroll(selected, tasks);
    // No Docker/runtime writes follow host completion, including failed release.
    if (fence) { releasing = true; await fence.release(); }
    return { config: result.config, policy: result.policy, directory: destination };
  } catch {
    if (fence && !releasing) await fence.release().catch(() => {});
    throw refused();
  }
}
