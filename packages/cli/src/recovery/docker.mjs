import { devNull } from 'node:os';
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

// Keep configuration and credentials out of command diagnostics.
export async function docker(args, { env = process.env, output, input, inputText } = {}) {
  const out = output ? await open(output, 'wx', 0o600) : null;
  const source = input ? await open(input, 'r') : null;
  try {
    return await new Promise((resolve, reject) => {
      let stdout = '';
      const child = spawn('docker', args, { env, stdio: [source?.fd ?? (inputText === undefined ? 'ignore' : 'pipe'), out?.fd ?? 'pipe', 'pipe'] });
      if (inputText !== undefined) { child.stdin.on('error', reject); child.stdin.end(inputText); }
      child.stdout?.on('data', chunk => { stdout += chunk; });
      child.stderr.resume();
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`Docker ${args[0]} failed (${code}); installation remains stopped. Inspect Docker state locally.`)));
    });
  } finally { await out?.sync(); await out?.close(); await source?.close(); }
}
export async function json(args, options) {
  const output = await docker(args, options);
  try { return JSON.parse(output); }
  catch { throw new Error(`Docker ${args[0]} returned unreadable JSON`); }
}
export const composeArgs = (file, project) => ['compose', '--env-file', devNull, '-f', file, '-p', project];
export const services = ['bucket-init', 'controller', 'minio', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b', 'workerd'];
export const volumes = ['bucket', 'controller', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b'];
export const volumeNames = config => Object.hasOwn(config.volumes || {}, 'tls') ? [...volumes, 'tls'] : [...volumes];
export function projectName(name) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name || '')) throw new Error('Expected a Docker project name (lowercase letters, digits, hyphens, underscores)');
  return name;
}
export async function projectContainers(project) {
  const ids = (await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).trim().split(/\s+/).filter(Boolean);
  return ids.length ? json(['inspect', ...ids]) : [];
}
export async function stopped(project, names) {
  if ((await projectContainers(project)).some(c => c.State.Running)) throw new Error('Project still has running containers');
  for (const name of names) {
    if ((await docker(['ps', '-q', '--filter', `volume=${name}`])).trim()) throw new Error('A snapshot volume still has a running writer');
  }
}
