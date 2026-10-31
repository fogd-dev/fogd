import { parseArgs } from 'node:util';
import { digest } from '../build-cache/paths.mjs';
import { readPreviewLaunchRequest } from './launch-request.mjs';
import { previewOwnerDocker } from './owner-control.mjs';
import { previewStorageSSH } from './storage-transport.mjs';
import { provisionAndRunPreview } from './launch.mjs';
import { previewForegroundOutput } from './foreground-output.mjs';

// Foreground ownership is deliberate: return only after the managed watcher
// finishes. Signal handlers remain installed throughout provisioning and stop.
export async function runPreviewForeground(input, publish) {
  const cancellation = new AbortController(), cancel = () => cancellation.abort();
  const output = publish ? null : previewForegroundOutput(cancel);
  publish ??= value => output.write(value);
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const active = await provisionAndRunPreview({ ...input, signal: cancellation.signal });
    try { await publish({ event: 'ready', ...active.ready }); }
    catch (error) { cancellation.abort(); await active.completion; throw error; }
    const stopped = await active.completion;
    if (output?.failure) throw output.failure;
    await publish({ event: 'stopped', ...stopped });
    if (!stopped.ordered) process.exitCode = 1;
    return stopped;
  } finally {
    output?.close();
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
}

export async function previewLaunchCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    request: { type: 'string' }, 'expected-request': { type: 'string' }, 'storage-host': { type: 'string' },
  } });
  if (positionals.length || !values.request || !digest(values['expected-request']) || !values['storage-host']) {
    throw new Error('Usage: fogd preview launch --request PRIVATE_DIRECTORY --expected-request SHA256 --storage-host SSH_ALIAS');
  }
  const { configuration } = await readPreviewLaunchRequest(values.request, values['expected-request']);
  return runPreviewForeground({ ...configuration, env: process.env,
    run: previewOwnerDocker(configuration.ownerControl.dockerContext), runStorageHost: previewStorageSSH(values['storage-host']) });
}
