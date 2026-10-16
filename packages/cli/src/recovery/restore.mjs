import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { docker, json, composeArgs, projectContainers, projectName, stopped, volumes } from './docker.mjs';
import { verifyBundle, restoredConfig, composeLiteral, writeJson } from './bundle.mjs';

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
  if (project === manifest.sourceProject) throw new Error('Restore requires a different project from its source');
  const target = restoredConfig(config, project, manifest.images);
  await requireFresh(project, target);
  await mkdir(destination, { mode: 0o700 });
  const started = Date.now(), file = join(destination, 'compose.json');
  await docker(['image', 'load'], { input: join(dir, 'images.tar') });
  const loaded = await json(['image', 'inspect', ...new Set(Object.values(manifest.images))]);
  if (Object.values(manifest.images).some(id => !loaded.some(image => image.Id === id))) throw new Error('Restored image identity mismatch');
  await writeJson(file, composeLiteral(target));
  const command = composeArgs(file, project);
  await docker([...command, 'create', '--pull', 'never']);
  await stopped(project, volumes.map(name => target.volumes[name].name));
  for (const name of volumes) {
    await docker(['run', '-i', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'FSETID', '--cap-add', 'DAC_OVERRIDE', '--security-opt', 'no-new-privileges', '--mount', `type=volume,src=${target.volumes[name].name},dst=/data`, manifest.images.controller, 'sh', '-c', 'tar --numeric-owner -C /data -xpf - && sync -f /data'], { input: join(dir, `${name}.tar`) });
  }
  for (const name of volumes) {
    await docker(['run', '-i', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--security-opt', 'no-new-privileges', '--mount', `type=volume,src=${target.volumes[name].name},dst=/data,readonly`, manifest.images.controller, 'tar', '--numeric-owner', '-C', '/data', '--compare', '-pf', '-'], { input: join(dir, `${name}.tar`) });
  }
  await writeJson(join(destination, 'restored.json'), { format: manifest.format, sourceProject: manifest.sourceProject, project, completedAt: new Date().toISOString(), durationMs: Date.now() - started });
  console.log(`Restore complete, still stopped. Start with: docker compose -f ${file} -p ${project} up -d --pull never`);
}
