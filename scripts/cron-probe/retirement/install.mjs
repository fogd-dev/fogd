import assert from 'node:assert/strict';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { verifyBundle, fingerprint } from '../../../packages/cli/src/recovery/bundle.mjs';
import { snapshotState } from '../../../packages/cli/src/recovery/snapshot-state.mjs';
import { validateBackgroundEvidence } from '../../../packages/cli/src/recovery/background-backup.mjs';
import { planRetirement } from '../../../packages/cli/src/recovery/retirement-plan.mjs';
import { restoreInstallation } from '../../../packages/cli/src/recovery/restore.mjs';
import { cronRestoreConfig } from '../../../packages/cli/src/runtime/cron-preboot.mjs';
import { projectName, stopped } from '../../../packages/cli/src/recovery/docker.mjs';
import { requireFreshTarget, cleanupNewTarget } from '../recovery/target.mjs';
import { retirementTransition, retirementVariant, assertRetirementHistory } from './policy.mjs';

export async function installRetirementTarget(source, request, createClient) {
  const { project, directory } = request;
  projectName(project);
  assert.ok(project.startsWith(source.rootProject+'-') && project !== source.project);
  const local = relative(source.rootDirectory, resolve(directory));
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local), 'Target must stay in its private qualification directory');
  await requireFreshTarget(project, directory, source.config);
  const manifestFingerprint = await fingerprint(join(request.bundle, 'manifest.json'));
  assert.deepEqual(manifestFingerprint, source.snapshotFingerprints.get(request.bundle), 'Backup differs from the fingerprint recorded by its source');
  const bundle = await verifyBundle(request.bundle), state = await snapshotState(request.bundle);
  projectName(bundle.manifest.sourceProject);
  assert.equal(bundle.manifest.sourceProject, source.project, 'Restore must use the selected stopped source');
  await stopped(source.project, Object.values(source.config.volumes).map(volume => volume.name));
  cronRestoreConfig(state, bundle.config, source.runtimeProfile);
  validateBackgroundEvidence(state, bundle.manifest);
  assertRetirementHistory(source.authority, source.variant, state);
  const change = selectedChange(source, request, bundle, state, manifestFingerprint), variant = change ? change.variant : source.variant;
  const profile = retirementVariant(source.authority, variant);
  const transformation = change?.plan || null;
  if (!transformation && profile.controllerArgs[0] === 'packages/platform/src/main.mjs') {
    // Sealing accepts this ordinary launch only because its independent profile
    // selected it before any target resource was created.
    assert.deepEqual(bundle.config.services.controller.command, profile.controllerArgs);
  }
  try {
    await restoreInstallation({ ...bundle, dir: request.bundle }, project, directory, transformation, profile);
    const config = JSON.parse(await readFile(join(directory, 'compose.json'), 'utf8'));
    const target = await createClient(directory, config, variant);
    for (const name of Object.keys(config.volumes)) assert.notEqual(config.volumes[name].name, source.config.volumes[name].name);
    return target;
  } catch (error) {
    try { await cleanupNewTarget(project, directory, source.config); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Sealed retirement install and cleanup failed', { cause: error }); }
    throw error;
  }
}
function selectedChange(source, request, bundle, state, manifestFingerprint) {
  if (request.kind === 'restore') return null;
  assert.equal(request.kind, 'retire');
  const { app, digest } = request, active = source.approvals[app];
  assert.ok(active); assert.equal(active.digest, digest);
  const selected = retirementTransition(source.authority, source.variant, app);
  assert.equal(active.slot, selected.slot);
  assert.equal(source.backgroundApps[app], selected.surface);
  const scheduled = selected.surface === 'dispatch';
  assert.equal(request.surface, selected.surface);
  const plan = planRetirement(bundle.config, state, app, digest, { id: selected.id, snapshot: manifestFingerprint,
    stopScheduledWork: scheduled, stopQueuedWork: !scheduled });
  plan.config.services.controller.command = [...selected.profile.controllerArgs];
  assertRetirementHistory(source.authority, selected.to, plan.state);
  cronRestoreConfig(plan.state, plan.config, selected.profile);
  return { plan, variant: selected.to };
}
