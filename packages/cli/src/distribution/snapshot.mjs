import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { copyTransferFile } from './files.mjs';
import { verifyTransferBundle } from './verify.mjs';

// Load from a private verified copy, not a transfer directory another process may
// replace while Docker reads it. This contains public software only.
export async function withTransferSnapshot(source, entry, expected, manifest, parent, operation) {
  const directory = await mkdtemp(join(parent, '.fogd-transfer-input-'));
  try {
    for (const path of ['manifest.json', ...Object.keys(manifest.files)]) {
      await copyTransferFile(join(source, path), join(directory, path), path === 'images.tar' ? manifest.files[path].bytes : 4 * 1024 ** 2);
    }
    await verifyTransferBundle(directory, entry, expected);
    return await operation(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
