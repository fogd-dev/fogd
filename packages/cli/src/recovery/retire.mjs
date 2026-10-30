import { recoveryOptions } from '../runtime/recovery-options.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { requestedRecoveryRuntime, selectedRecoveryPlan, retiredRuntimePolicy } from '../runtime/recovery-selection.mjs';
import { parseArgs } from 'node:util';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyBundle, fingerprint, readJson } from './bundle.mjs';
import { snapshotState } from './snapshot-state.mjs';
import { projectName } from './docker.mjs';
import { restoreInstallation } from './restore.mjs';
import { planRetirement } from './retirement-plan.mjs';
import { validateBackgroundEvidence } from './background-backup.mjs';
import { durableSnapshotFormat } from './durable-bundle.mjs';
import { retireDurableInstallation } from './durable-restore.mjs';
import { readDurableRetirementPlan } from '../runtime/durable-retirement-plan.mjs';
import { retirementReview } from './retirement-review.mjs';

export async function retire(directory, app, digest, project, output, stopQueuedWork = false, stopScheduledWork = false, selection = {}, expectedPlan) {
  requestedRecoveryRuntime(selection);
  if (expectedPlan !== undefined && (typeof expectedPlan !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPlan))) throw new Error('Reviewed retirement requires a SHA256 plan digest');
  projectName(project);
  const dir = resolve(directory), destination = resolve(output);
  const manifestPath = join(dir, 'manifest.json');
  if (!(await lstat(manifestPath)).isFile()) throw new Error('Retirement requires a regular snapshot manifest');
  const manifest = await readJson(manifestPath);
  if (manifest.format === durableSnapshotFormat) {
    await retireDurableInstallation(dir, project, destination, selection, { app, digest, stopQueuedWork, stopScheduledWork, expectedPlan });
  } else {
    if (expectedPlan !== undefined) throw new Error('Reviewed retirement requires a selected durable snapshot');
    await retireLegacy(dir, app, digest, project, destination, stopQueuedWork, stopScheduledWork, selection);
  }
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
  const preview = args[0] === 'plan';
  const { values, positionals } = parseArgs({ args: preview ? args.slice(1) : args, allowPositionals: true, options: { runtime: { type: 'string' }, 'expected-identity': { type: 'string' }, 'network-plan': { type: 'string' }, 'expected-plan': { type: 'string' }, 'stop-scheduled-work': { type: 'boolean' }, 'stop-queued-work': { type: 'boolean' }, app: { type: 'string' }, digest: { type: 'string' }, project: { type: 'string' }, output: { type: 'string' } } });
  const required = preview ? ['app', 'digest', 'project'] : ['app', 'digest', 'project', 'output'];
  if (positionals.length !== 1 || required.some(name => !values[name]) || preview && (values.output !== undefined || values['expected-plan'] !== undefined)) {
    throw new Error('Usage: fogd retire [plan] BUNDLE --app NAME --digest SHA --project NEW [--output DIR --expected-plan SHA256] [--stop-queued-work] [--stop-scheduled-work] [--runtime FAMILY --expected-identity SHA256 [--network-plan FILE]]');
  }
  const selection = await recoveryOptions(values);
  if (preview) {
    const plan = await readDurableRetirementPlan(resolve(positionals[0]), values.project, selection, { app: values.app, digest: values.digest,
      stopQueuedWork: values['stop-queued-work'], stopScheduledWork: values['stop-scheduled-work'] });
    console.log(JSON.stringify(retirementReview(plan), null, 2));
  } else await retire(positionals[0], values.app, values.digest, values.project, values.output, values['stop-queued-work'], values['stop-scheduled-work'], selection, values['expected-plan']);
}
