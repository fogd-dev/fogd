import { devNull } from 'node:os';
import { execute } from './execute.mjs';
export const docker = (args, options) => execute('docker', args, options);
export async function json(args, options) {
  const output = await docker(args, options);
  try { return JSON.parse(output); }
  catch { throw new Error(`Docker ${args[0]} returned unreadable JSON`); }
}
export const composeArgs = (file, project) => ['compose', '--env-file', devNull, '-f', file, '-p', project];
export { volumeNames } from './layout.mjs';
export function projectName(name) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name || '')) throw new Error('Expected a Docker project name (lowercase letters, digits, hyphens, underscores)');
  return name;
}
export async function projectContainers(project) {
  const ids = (await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).trim().split(/\s+/).filter(Boolean);
  return ids.length ? json(['inspect', ...ids]) : [];
}
export async function stopped(project, names) {
  if ((await projectContainers(project)).some(c => c.State.Running || c.State.Restarting || c.State.Paused)) throw new Error('Project still has running containers');
  for (const name of names) {
    if ((await docker(['ps', '-q', '--filter', `volume=${name}`])).trim()) throw new Error('A snapshot volume still has a running writer');
  }
}

export async function requireFresh(project, config) {
  if ((await projectContainers(project)).length) throw new Error('Target project already has containers');
  for (const kind of ['volume', 'network']) {
    const existing = new Set((await docker([kind, 'ls', '--format', '{{.Name}}'])).trim().split('\n'));
    const labeled = (await docker([kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])).trim();
    const names = Object.values(config[kind === 'volume' ? 'volumes' : 'networks']).map(item => item.name);
    if (labeled || names.some(name => existing.has(name))) throw new Error('Target resources already exist; choose a fresh project');
  }
}
