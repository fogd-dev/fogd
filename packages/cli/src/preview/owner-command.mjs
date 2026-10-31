import { parseArgs } from 'node:util';
import { uuid } from '../build-cache/paths.mjs';
import { performPreviewOwnerAction } from './owner-actions.mjs';

export async function previewOwnerCommand(action, args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    control: { type: 'string' }, ...(action === 'stop' ? { reason: { type: 'string' } } : {}),
  } });
  if (positionals.length !== 1 || !uuid(positionals[0]) || !values.control ||
    values.reason !== undefined && !['owner-stop', 'declined', 'revoked'].includes(values.reason)) throw new Error(`Usage: fogd preview ${action} ALLOCATION_UUID --control OWNER_DIRECTORY${action === 'stop' ? ' [--reason owner-stop|declined|revoked]' : ''}`);
  const result = await performPreviewOwnerAction(action, { directory: values.control, allocationId: positionals[0], reason: values.reason });
  console.log(JSON.stringify(result, null, 2));
  if (!result.runtimeObserved || result.shutdownOrdered === false) process.exitCode = 1;
}
