import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { verifyBundle, fingerprint } from './bundle.mjs';
import { snapshotState } from './snapshot-state.mjs';
import { stopped, projectName, volumeNames } from './docker.mjs';
import { restoreInstallation } from './restore.mjs';
import { planExpansion } from './expansion-plan.mjs';
import { assertQueueFreeRecovery } from './queue-safety.mjs';

export async function expand(directory, project, output) {
  projectName(project);
  const dir = resolve(directory), destination = resolve(output), bundle = await verifyBundle(dir);
  projectName(bundle.manifest.sourceProject);
  const state = await snapshotState(dir);
  assertQueueFreeRecovery(state);
  const plan = planExpansion(bundle.config, state, bundle.manifest.images, { snapshot: await fingerprint(join(dir, 'manifest.json')) });
  await stopped(bundle.manifest.sourceProject, volumeNames(bundle.config).map(name => bundle.config.volumes[name].name));
  await restoreInstallation({ ...bundle, dir }, project, destination, plan);
  console.log(`Expanded into ${project} with three fleets. Source and target remain stopped; original applications and authority are preserved.`);
}
export async function expansionCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(['fleets', 'project', 'output'].map(name => [name, { type: 'string' }])) });
  if (positionals.length !== 1 || values.fleets !== '3' || !values.project || !values.output) throw new Error('Usage: fogd expand BUNDLE --fleets 3 --project NEW --output DIRECTORY');
  await expand(positionals[0], values.project, values.output);
}
