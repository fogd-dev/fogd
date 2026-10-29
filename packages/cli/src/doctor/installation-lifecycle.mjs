import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { finding } from './report.mjs';

export async function installationLifecycleFinding(directory) {
  try {
    await lstat(join(directory, 'launch.pending.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return finding('lifecycle-fence', 'supported', 'No retained launch/shutdown marker was observed.', 'This is not a writer lock or startup authorization.');
    return finding('lifecycle-fence', 'unverified', 'The retained launch/shutdown marker could not be inspected.', 'Retain host records and inspect the operation before startup.');
  }
  return finding('lifecycle-fence', 'unverified', 'A retained launch/shutdown operation is present.', 'Keep ingress stopped and inspect its original operation and container state; this check never removes the marker.');
}
