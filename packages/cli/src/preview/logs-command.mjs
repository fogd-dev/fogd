import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { uuid } from '../build-cache/paths.mjs';
import { capturePreviewLogs } from './logs.mjs';

export async function previewLogsCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    control: { type: 'string' }, role: { type: 'string' }, output: { type: 'string' }, tail: { type: 'string', default: '2000' },
  } });
  if (positionals.length !== 1 || !uuid(positionals[0]) || !values.control || !values.role || !values.output ||
    !/^[1-9][0-9]{0,4}$/.test(values.tail) || Number(values.tail) > 10000) throw new Error('Usage: fogd preview logs ALLOCATION_UUID --control OWNER_DIRECTORY --role ROLE --output NEW_PRIVATE_DIRECTORY [--tail 1..10000]');
  const result = await capturePreviewLogs({ directory: resolve(values.control), allocationId: positionals[0], role: values.role, output: values.output, tail: Number(values.tail) });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'captured') process.exitCode = 1;
}
