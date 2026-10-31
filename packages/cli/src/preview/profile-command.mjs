import { parseArgs } from 'node:util';
import { digest } from '../build-cache/paths.mjs';
import { previewOwnerDocker } from './owner-control.mjs';
import { previewStorageSSH } from './storage-transport.mjs';
import { initializePreviewProfile, readPreviewProfile, inspectPreviewProfile } from './profile.mjs';
import { readPreviewProfileState } from './profile-records.mjs';
import { completePreviewProfile } from './profile-completion.mjs';

const usage = 'Usage: fogd preview profile init --docker-context CONTEXT --storage-host SSH_ALIAS --storage-root LINUX_DIRECTORY --max-projects N --output NEW_PRIVATE_DIRECTORY\n       fogd preview profile status|complete DIRECTORY --expected-profile SHA256 --storage-host SSH_ALIAS';
export async function previewProfileCommand(action, args) {
  if (!['init', 'status', 'complete'].includes(action)) throw new Error(usage);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'storage-host': { type: 'string' }, ...(action === 'init' ? {
      'docker-context': { type: 'string' }, 'storage-root': { type: 'string' }, 'max-projects': { type: 'string' }, output: { type: 'string' },
    } : { 'expected-profile': { type: 'string' } }),
  } });
  if (!values['storage-host']) throw new Error(usage);
  const runHost = previewStorageSSH(values['storage-host']);
  let result;
  if (action === 'init') {
    if (positionals.length || !values.output || !values['docker-context'] || !values['storage-root'] || !/^(?:[1-9]|1[0-6])$/.test(values['max-projects'] ?? '')) throw new Error(usage);
    result = await initializePreviewProfile({ output: values.output, dockerContext: values['docker-context'], storageRoot: values['storage-root'],
      maxProjects: Number(values['max-projects']), run: previewOwnerDocker(values['docker-context']), runHost });
  } else {
    if (positionals.length !== 1 || !digest(values['expected-profile'])) throw new Error(usage);
    const profile = action === 'complete' ? (await readPreviewProfileState(positionals[0], values['expected-profile'])).profile : await readPreviewProfile(positionals[0], values['expected-profile']);
    const operation = action === 'complete' ? completePreviewProfile : inspectPreviewProfile;
    result = await operation({ directory: positionals[0], expectedProfileSha256: values['expected-profile'], run: previewOwnerDocker(profile.dockerContext), runHost });
  }
  console.log(JSON.stringify(result, null, 2));
}
