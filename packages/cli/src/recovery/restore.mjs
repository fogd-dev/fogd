import { mkdir, rename, open } from 'node:fs/promises';
import { restoreVolumes, volumeHelper } from './volumes.mjs';
import { retirementCapability } from '@fogd/platform/retirement';
import { join, resolve } from 'node:path';
import { docker, json, composeArgs, projectContainers, projectName, stopped, volumeNames } from './docker.mjs';
import { verifyBundle, restoredConfig, composeLiteral, writeJson, validateTopology } from './bundle.mjs';
import { restoredQueueState } from './queue-restore.mjs';
import { queueRecoveryCapability } from '@fogd/platform/queue-snapshot';

async function requireFresh(project, config) {
  if ((await projectContainers(project)).length) throw new Error('Restore target project already has containers');
  for (const kind of ['volume', 'network']) {
    const existing = new Set((await docker([kind, 'ls', '--format', '{{.Name}}'])).trim().split('\n'));
    const labeled = (await docker([kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])).trim();
    const names = Object.values(config[kind === 'volume' ? 'volumes' : 'networks']).map(item => item.name);
    if (labeled || names.some(name => existing.has(name))) throw new Error('Restore target resources already exist; choose a fresh project');
  }
}
export async function restore(directory, project, output) {
  projectName(project);
  const dir = resolve(directory), destination = resolve(output);
  const { manifest, config } = await verifyBundle(dir);
  return restoreInstallation({ manifest, config, dir }, project, destination);
}
export async function restoreInstallation({ manifest, config, dir }, project, destination, change = null) {
  const queueState = await restoredQueueState(dir, manifest, change);
  const sourceVolumes = volumeNames(config), images = change?.images || manifest.images;
  if (change && !['retirement', 'expansion'].includes(change.kind)) throw new Error('Unknown installation transformation');
  if (Object.values(images).some(id => !Object.values(manifest.images).includes(id))) throw new Error('Transformation may only use snapshot images');
  if (project === manifest.sourceProject) throw new Error('Restore requires a different project from its source');
  const target = restoredConfig(change?.config || config, project, images);
  validateTopology(target);
  const volumes = volumeNames(target);
  await requireFresh(project, target);
  await mkdir(destination, { mode: 0o700 });
  const started = Date.now(), file = join(destination, 'compose.pending.json');
  await docker(['image', 'load'], { input: join(dir, 'images.tar') });
  const loaded = await json(['image', 'inspect', ...new Set(Object.values(manifest.images))]);
  if (Object.values(manifest.images).some(id => !loaded.some(image => image.Id === id))) throw new Error('Restored image identity mismatch');
  if (change?.kind === 'retirement') await requireRetirementRuntime(manifest.images.controller);
  if (queueState) await requireQueueRecoveryRuntime(manifest.images.controller);
  await writeJson(file, composeLiteral(target));
  const command = composeArgs(file, project);
  await docker([...command, 'create', '--pull', 'never']);
  await stopped(project, volumes.map(name => target.volumes[name].name));
  await restoreVolumes(dir, target, volumes, manifest.images.controller, change?.skipped);
  if (queueState) await writeRetirement(target, manifest.images.controller, queueState);
  if (change) {
    if (change.kind === 'retirement') await writeRetirement(target, manifest.images.controller, change.state);
    await writeJson(join(destination, `${change.kind}.json`), change.evidence);
    await stopped(manifest.sourceProject, sourceVolumes.map(name => config.volumes[name].name));
  }
  await stopped(project, volumes.map(name => target.volumes[name].name));
  await rename(file, join(destination, 'compose.json'));
  const parent = await open(destination, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  await writeJson(join(destination, 'restored.json'), { format: manifest.format, sourceProject: manifest.sourceProject, project, completedAt: new Date().toISOString(), durationMs: Date.now() - started, retirement: change?.kind === 'retirement' ? change.evidence.id : null, expansion: change?.kind === 'expansion' ? change.evidence.id : null });
  console.warn('Restoring an older snapshot can resurrect application access, deploy credentials, and secret revisions. Keep the source stopped.');
  console.log(`Restore complete, still stopped. Start with: docker compose -f ${join(destination, 'compose.json')} -p ${project} up -d --pull never`);
}

async function requireQueueRecoveryRuntime(image) {
  let capability;
  try { capability = await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', image, 'node', '--input-type=module', '-e', "import {queueRecoveryCapability} from './packages/platform/src/queue-snapshot.mjs'; console.log(queueRecoveryCapability)"]); }
  catch { throw new Error('Snapshot runtime does not support queue recovery; upgrade the source and take a new snapshot'); }
  if (capability.trim() !== queueRecoveryCapability) throw new Error('Snapshot queue recovery capability differs from the CLI');
}

async function requireRetirementRuntime(image) {
  let capability;
  try { capability = await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', image, 'node', '--input-type=module', '-e', "import {retirementCapability} from './packages/platform/src/retirement.mjs'; console.log(retirementCapability)"]); }
  catch { throw new Error('Snapshot runtime does not support retirement; upgrade the source and take a new snapshot'); }
  if (capability.trim() !== retirementCapability) throw new Error('Snapshot retirement capability differs from the CLI');
}
async function writeRetirement(target, image, state) {
  const code = "import {saveJson} from './packages/platform/src/store.mjs'; let input=''; for await(const part of process.stdin) input+=part; await saveJson('/data/state.json', JSON.parse(input));";
  await volumeHelper(image, target.volumes.controller.name, ['node', '--input-type=module', '-e', code], { readonly: false, inputText: JSON.stringify(state) });
  const output = await volumeHelper(image, target.volumes.controller.name, ['cat', '/data/state.json']);
  if (JSON.stringify(JSON.parse(output)) !== JSON.stringify(state)) throw new Error('Retirement metadata verification failed');
}
