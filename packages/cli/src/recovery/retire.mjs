import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { verifyBundle, fingerprint } from './bundle.mjs';
import { snapshotState } from './snapshot-state.mjs';
import { projectName } from './docker.mjs';
import { restoreInstallation } from './restore.mjs';
import { planRetirement } from './retirement-plan.mjs';
import { validateBackgroundEvidence } from './background-backup.mjs';

export async function retire(directory, app, digest, project, output, stopQueuedWork = false, stopScheduledWork = false) {
  projectName(project);
  const dir = resolve(directory), destination = resolve(output);
  const bundle = await verifyBundle(dir);
  projectName(bundle.manifest.sourceProject);
  const state = await snapshotState(dir);
  validateBackgroundEvidence(state, bundle.manifest);
  const plan = planRetirement(bundle.config, state, app, digest, { stopQueuedWork, stopScheduledWork, snapshot: await fingerprint(join(dir, 'manifest.json')) });
  await restoreInstallation({ ...bundle, dir }, project, destination, plan);
  console.log(`Retired ${app} in ${project}. Retained data and old credentials remain in private recovery material; the name cannot be reused.`);
}

export async function retirementCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'stop-scheduled-work': { type: 'boolean' }, 'stop-queued-work': { type: 'boolean' }, app: { type: 'string' }, digest: { type: 'string' }, project: { type: 'string' }, output: { type: 'string' } } });
  if (positionals.length !== 1 || ['app', 'digest', 'project', 'output'].some(name => !values[name])) throw new Error('Usage: fogd retire BUNDLE --app NAME --digest SHA --project NEW --output DIR [--stop-queued-work] [--stop-scheduled-work]');
  await retire(positionals[0], values.app, values.digest, values.project, values.output, values['stop-queued-work'], values['stop-scheduled-work']);
}
