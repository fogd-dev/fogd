import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { exportReleaseBundle } from './bundle.mjs';
import { verifyReleaseFiles } from '../distribution/bootstrap.mjs';

export async function releaseCommand(args) {
  const [action, ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    version: { type: 'string' }, runtime: { type: 'string' }, 'expected-manifest': { type: 'string' },
  } });
  const keys = { export: ['version', 'runtime'], verify: ['expected-manifest'] }[action];
  if (!keys || positionals.length !== 1 || keys.some(key => !values[key]) || Object.keys(values).some(key => !keys.includes(key))) {
    throw new Error('Usage: fogd release export DIRECTORY --version VERSION --runtime FAMILY | verify DIRECTORY --expected-manifest SHA');
  }
  const directory = resolve(positionals[0]);
  const result = action === 'export' ? await exportReleaseBundle(directory, values.version, values.runtime)
    : await verifiedRelease(directory, values['expected-manifest']);
  console.log(JSON.stringify(result, null, 2));
}
async function verifiedRelease(directory, expected) {
  const manifest = await verifyReleaseFiles(directory, expected);
  return { directory, version: manifest.version, runtime: manifest.runtime, manifestSha256: expected,
    runtimeManifestSha256: manifest.runtimeManifestSha256, clientManifestSha256: manifest.clientManifestSha256,
    verifiedFiles: Object.keys(manifest.files).length, dockerContacted: false };
}
