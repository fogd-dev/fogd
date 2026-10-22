import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { exportClientBundle } from './bundle.mjs';
import { verifyClientFiles } from '../distribution/bootstrap.mjs';

export async function clientCommand(args) {
  const [action, ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { 'expected-manifest': { type: 'string' } } });
  if (!['export', 'verify'].includes(action) || positionals.length !== 1 || (action === 'export' ? Object.keys(values).length : !values['expected-manifest'])) throw new Error('Usage: fogd client export DIRECTORY | verify DIRECTORY --expected-manifest SHA');
  const directory = resolve(positionals[0]);
  let result;
  if (action === 'export') result = await exportClientBundle(directory);
  else {
    const manifest = await verifyClientFiles(directory, values['expected-manifest']);
    result = { directory, manifestSha256: values['expected-manifest'], verifiedFiles: Object.keys(manifest.files).length, dockerContacted: false };
  }
  console.log(JSON.stringify(result, null, 2));
}
