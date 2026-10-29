import { randomUUID } from 'node:crypto';
import { docker } from '../recovery/docker.mjs';
import { cleanupObserver } from './cleanup.mjs';

// Callers verify the image and backing path. Existing bind sources refuse
// disappearance rather than recreating a named volume.
export async function runObservationHelper(installation, { purpose, mount, code, inputText, maxOutputBytes = 4096 }, run = docker) {
  if (!/^[a-z-]+$/.test(purpose)) throw new Error('Invalid observation purpose');
  const nonce = randomUUID(), name = `fogd-${purpose}-${nonce}`;
  try {
    return await run(['run', '--rm', '--pull', 'never', ...(inputText === undefined ? [] : ['-i']), '--name', name,
      '--label', `fogd.observer.id=${nonce}`, '--label', `fogd.observer.project=${installation.project}`,
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '0.25', '--pids-limit', '32',
      '--mount', mount, '--entrypoint', '/usr/local/bin/node', installation.entry.image, '--input-type=module', '-e', code],
    { timeoutMs: 15000, maxOutputBytes, ...(inputText === undefined ? {} : { inputText }) });
  } finally { await cleanupObserver(name, nonce, run); }
}
