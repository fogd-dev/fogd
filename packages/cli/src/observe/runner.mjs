import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { docker } from '../recovery/docker.mjs';
import { cleanupObserver } from './cleanup.mjs';
export { ObserverCleanupError } from './cleanup.mjs';

export async function sampleNative(installation, selection, network) {
  const nonce = randomUUID(), name = `fogd-observe-${nonce}`, { config, entry } = installation;
  const env = Object.fromEntries(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'FOGD_BUCKET', 'S3_ENDPOINT', 'FOGD_SLOTS'].map(key => [key, config.services.controller.environment[key]]));
  try {
    const code = (await readFile(new URL('./worker.mjs', import.meta.url), 'utf8')) + '\nawait main();\n';
    const text = await docker(['run', '--rm', '-i', '--pull', 'never', '--name', name, '--label', `fogd.observer.id=${nonce}`, '--label', `fogd.observer.project=${installation.project}`,
      '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '0.5', '--memory', '128m',
      '--entrypoint', '/usr/local/bin/node', entry.image, '--input-type=module', '-e', code],
      { inputText: JSON.stringify({ env, profile: installation.policy, expected: { slot: selection.expected.slot, version: selection.expected.version } }), timeoutMs: 45000 });
    return JSON.parse(text);
  } catch (error) {
    await cleanupObserver(name, nonce);
    return { unavailable: error.message.includes('timed out') ? 'timeout' : 'helper-failed' };
  }
}
