import { parseArgs } from 'node:util';
import { digest } from '../build-cache/paths.mjs';
import { readPreviewProfile } from './profile.mjs';
import { previewOwnerDocker } from './owner-control.mjs';
import { previewStorageSSH } from './storage-transport.mjs';
import { inspectPreviewStorageSetup, reconcilePreviewStorageSetup } from './storage-request-recovery.mjs';

export async function previewStorageRecoveryCommand(action, args) {
  if (!['inspect', 'reconcile'].includes(action)) throw new Error('Unknown preview storage recovery action');
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    profile: { type: 'string' }, 'expected-profile': { type: 'string' }, preparation: { type: 'string' },
    'expected-preparation': { type: 'string' }, 'storage-request': { type: 'string' }, 'storage-host': { type: 'string' },
    ...(action === 'reconcile' ? { 'expected-review': { type: 'string' } } : {}),
  } });
  if (positionals.length || ['profile', 'preparation', 'storage-request', 'storage-host'].some(name => !values[name]) ||
    !digest(values['expected-profile']) || !digest(values['expected-preparation']) || action === 'reconcile' && !digest(values['expected-review'])) {
    throw new Error(`Usage: fogd preview storage ${action} --profile DIRECTORY --expected-profile SHA256 --preparation DIRECTORY --expected-preparation SHA256 --storage-request DIRECTORY --storage-host SSH_ALIAS${action === 'reconcile' ? ' --expected-review SHA256' : ''}`);
  }
  const profile = await readPreviewProfile(values.profile, values['expected-profile']);
  const input = { profileDirectory: profile.directory, expectedProfileSha256: values['expected-profile'], directory: values.preparation,
    expectedPreparationSha256: values['expected-preparation'], storageDirectory: values['storage-request'], expectedReviewSha256: values['expected-review'],
    run: previewOwnerDocker(profile.dockerContext), runHost: previewStorageSSH(values['storage-host']) };
  const result = await (action === 'inspect' ? inspectPreviewStorageSetup(input) : reconcilePreviewStorageSetup(input));
  console.log(JSON.stringify(result, null, 2));
}
