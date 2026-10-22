import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { runtimeFamily } from '../runtime/catalog.mjs';
import { exportRuntimeBundle, importRuntimeBundle } from './bundle.mjs';
import { verifyTransferBundle } from './verify.mjs';

export async function runtimeCommand(args) {
  const [action, ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    runtime: { type: 'string' }, 'expected-manifest': { type: 'string' }, output: { type: 'string' },
  } });
  const keys = { export: ['runtime'], verify: ['runtime', 'expected-manifest'], import: ['runtime', 'expected-manifest', 'output'] }[action];
  if (!keys || positionals.length !== 1 || Object.keys(values).some(key => !keys.includes(key)) || keys.some(key => !values[key])) {
    throw new Error('Usage: fogd runtime export DIRECTORY --runtime FAMILY | verify DIRECTORY --runtime FAMILY --expected-manifest SHA | import DIRECTORY --runtime FAMILY --expected-manifest SHA --output NEW_DIRECTORY');
  }
  const directory = resolve(positionals[0]); let result;
  if (action === 'export') result = await exportRuntimeBundle(directory, values.runtime);
  else if (action === 'import') result = await importRuntimeBundle(directory, values.runtime, values['expected-manifest'], values.output);
  else {
    const manifest = await verifyTransferBundle(directory, runtimeFamily(values.runtime), values['expected-manifest']);
    result = { directory, family: manifest.runtime.id, manifestSha256: values['expected-manifest'], verifiedFiles: Object.keys(manifest.files).length, dockerContacted: false };
  }
  console.log(JSON.stringify(result, null, 2));
}
