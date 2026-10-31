import { parseArgs } from 'node:util';
import { dirname, basename, resolve } from 'node:path';
import { digest } from '../build-cache/paths.mjs';
import { bindHostDirectory } from '../runtime/host-directory.mjs';
import { readPrivatePreviewFile } from './private-record.mjs';
import { readPreviewProfile } from './profile.mjs';
import { previewOwnerDocker } from './owner-control.mjs';
import { previewStorageSSH } from './storage-transport.mjs';
import { preparePreviewStorageRequest } from './storage-request.mjs';
import { createProfilePreviewRequest } from './request-setup.mjs';
import { executionKeys } from './execution-shape.mjs';

const commonUsage = '--profile DIRECTORY --expected-profile SHA256 --preparation DIRECTORY --expected-preparation SHA256 --storage-host SSH_ALIAS --output NEW_PRIVATE_DIRECTORY';
const usage = action => `Usage: fogd preview ${action === 'storage' ? 'storage prepare' : 'request'} ${commonUsage}${action === 'request' ? ' --storage-request DIRECTORY --expected-storage-request SHA256 --settings PRIVATE_JSON' : ''}`;
export async function readPreviewRequestSettings(path) {
  try {
    const file = resolve(path), parent = await bindHostDirectory(dirname(file));
    const value = JSON.parse(await readPrivatePreviewFile(parent, basename(file), 65536));
    executionKeys(value, ['origin', 'subnets', 'tls', 'secrets']); executionKeys(value.tls, ['gateway', 'ingress']);
    const tls = {};
    for (const role of ['gateway', 'ingress']) {
      executionKeys(value.tls[role], ['certFile', 'keyFile']); tls[role] = {};
      for (const [field, setting] of [['cert', 'certFile'], ['key', 'keyFile']]) {
        const target = resolve(dirname(file), value.tls[role][setting]), directory = await bindHostDirectory(dirname(target));
        tls[role][field] = (await readPrivatePreviewFile(directory, basename(target), 32768)).toString('utf8');
      }
    }
    return { ...value, tls };
  } catch {
    const error = new Error('Preview request settings refused; use a bounded private JSON file');
    error.code = 'PREVIEW_REQUEST_SETTINGS_REFUSED'; throw error;
  }
}
function validSelection(action, values, positionals) {
  const required = ['profile', 'preparation', 'output', 'storage-host'];
  if (positionals.length || required.some(name => !values[name]) || !digest(values['expected-profile']) || !digest(values['expected-preparation'])) throw new Error(usage(action));
  if (action === 'request' && (!values.settings || !values['storage-request'] || !digest(values['expected-storage-request']))) throw new Error(usage(action));
}
export async function previewSetupCommand(action, args) {
  if (!['storage', 'request'].includes(action)) throw new Error(usage(action));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    profile: { type: 'string' }, 'expected-profile': { type: 'string' }, preparation: { type: 'string' },
    'expected-preparation': { type: 'string' }, 'storage-host': { type: 'string' }, output: { type: 'string' },
    ...(action === 'request' ? { 'storage-request': { type: 'string' }, 'expected-storage-request': { type: 'string' }, settings: { type: 'string' } } : {}),
  } });
  validSelection(action, values, positionals);
  const profile = await readPreviewProfile(values.profile, values['expected-profile']);
  const input = { profileDirectory: profile.directory, expectedProfileSha256: values['expected-profile'], directory: values.preparation,
    expectedPreparationSha256: values['expected-preparation'], output: values.output, env: process.env,
    run: previewOwnerDocker(profile.dockerContext), runHost: previewStorageSSH(values['storage-host']) };
  const result = action === 'storage' ? await preparePreviewStorageRequest(input) : await createProfilePreviewRequest({ ...input,
    storageDirectory: values['storage-request'], expectedStorageRequestSha256: values['expected-storage-request'], settings: await readPreviewRequestSettings(values.settings) });
  console.log(JSON.stringify(result, null, 2));
}
