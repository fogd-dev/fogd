import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { verifyBundle, fingerprint } from './bundle.mjs';
import { snapshotState } from './snapshot-state.mjs';
import { stopped, projectName, volumeNames } from './docker.mjs';
import { restoreInstallation } from './restore.mjs';
import { planRetirement } from './retirement-plan.mjs';

export async function retire(directory, app, digest, project, output) {
  projectName(project);
  const dir = resolve(directory), destination = resolve(output);
  const bundle = await verifyBundle(dir);
  projectName(bundle.manifest.sourceProject);
  const state = await snapshotState(dir);
  const plan = planRetirement(bundle.config, state, app, digest, { snapshot: await fingerprint(join(dir, 'manifest.json')) });
  await stopped(bundle.manifest.sourceProject, volumeNames(bundle.config).map(name => bundle.config.volumes[name].name));
  await restoreInstallation({ ...bundle, dir }, project, destination, plan);
  console.log(`Retired ${app} in ${project}. Retained data and old credentials remain in private recovery material; the name cannot be reused.`);
}

export async function retirementCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { app: { type: 'string' }, digest: { type: 'string' }, project: { type: 'string' }, output: { type: 'string' } } });
  if (positionals.length !== 1 || ['app', 'digest', 'project', 'output'].some(name => !values[name])) throw new Error('Usage: fogd retire BUNDLE --app NAME --digest SHA --project NEW --output DIR');
  await retire(positionals[0], values.app, values.digest, values.project, values.output);
}
