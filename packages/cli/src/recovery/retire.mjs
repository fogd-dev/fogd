import { recoveryOptions } from '../runtime/recovery-options.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { requestedRecoveryRuntime, selectedRecoveryPlan, retiredRuntimePolicy } from '../runtime/recovery-selection.mjs';
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { verifyBundle, fingerprint, readJson } from './bundle.mjs';
import { snapshotState } from './snapshot-state.mjs';
import { projectName } from './docker.mjs';
import { restoreInstallation } from './restore.mjs';
import { planRetirement } from './retirement-plan.mjs';
import { validateBackgroundEvidence } from './background-backup.mjs';
import { durableSnapshotFormat } from './durable-bundle.mjs';
import { retireDurableInstallation } from './durable-restore.mjs';

export async function retire(directory, app, digest, project, output, stopQueuedWork = false, stopScheduledWork = false, selection = {}) {
  requestedRecoveryRuntime(selection);
  projectName(project);
  const dir = resolve(directory), destination = resolve(output);
  const manifest = await readJson(join(dir, 'manifest.json'));
  if (manifest.format === durableSnapshotFormat) {
    await retireDurableInstallation(dir, project, destination, selection, { app, digest, stopQueuedWork, stopScheduledWork });
  } else await retireLegacy(dir, app, digest, project, destination, stopQueuedWork, stopScheduledWork, selection);
  console.log(`Retired ${app} in ${project}. Retained data and old credentials remain in private recovery material; the name cannot be reused.`);
}

async function retireLegacy(dir, app, digest, project, destination, stopQueuedWork, stopScheduledWork, selection) {
  const bundle = await verifyBundle(dir);
  projectName(bundle.manifest.sourceProject);
  const selected = selectedRecoveryPlan(bundle, selection);
  const state = await snapshotState(dir);
  validateBackgroundEvidence(state, bundle.manifest);
  const plan = planRetirement(bundle.config, state, app, digest, { stopQueuedWork, stopScheduledWork, snapshot: await fingerprint(join(dir, 'manifest.json')) });
  const policy = selected && retiredRuntimePolicy(selected, plan.config, state.apps[app].slot);
  if (selected) {
    plan.evidence.runtimeSelection = { family: selected.entry.id, sourceIdentitySha256: runtimePolicyIdentity(selected.sourcePolicy), targetIdentitySha256: runtimePolicyIdentity(policy) };
    plan.state.apps[app].retirement.runtimeSelection = structuredClone(plan.evidence.runtimeSelection);
  }
  await restoreInstallation({ ...bundle, dir }, project, destination, plan, policy, { selected: Boolean(selected) });
}

export async function retirementCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { runtime: { type: 'string' }, 'expected-identity': { type: 'string' }, 'network-plan': { type: 'string' }, 'stop-scheduled-work': { type: 'boolean' }, 'stop-queued-work': { type: 'boolean' }, app: { type: 'string' }, digest: { type: 'string' }, project: { type: 'string' }, output: { type: 'string' } } });
  if (positionals.length !== 1 || ['app', 'digest', 'project', 'output'].some(name => !values[name])) throw new Error('Usage: fogd retire BUNDLE --app NAME --digest SHA --project NEW --output DIR [--stop-queued-work] [--stop-scheduled-work] [--runtime FAMILY --expected-identity SHA256 [--network-plan FILE]]');
  await retire(positionals[0], values.app, values.digest, values.project, values.output, values['stop-queued-work'], values['stop-scheduled-work'], await recoveryOptions(values));
}
