import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { previewInputFile } from './input-files.mjs';
import { hostRefusal } from './host-records.mjs';

// Caller supplies a fresh private directory. Copies come from the actual
// application-facing mounts, not from the installer or a previous readback.
export async function readPreviewInputMounts(root, identities, snapshot, run) {
  for (const [group, files] of Object.entries(snapshot.files)) {
    const role = group.slice(0, group.lastIndexOf('-')), type = group.endsWith('-trust') ? 'trust' : 'input';
    const target = type === 'trust' ? '/run/fogd-preview-trust' : role === 'controller' ? '/run/fogd-preview-input' : '/run/fogd-preview-service';
    const directory = join(root, group); await mkdir(directory, { mode: 0o700 });
    await run(['cp', `${identities.containers[role]}:${target}/.`, directory]);
    if (!isDeepStrictEqual((await readdir(directory)).sort(), Object.keys(files).sort())) hostRefusal('input-readback');
    for (const [name, expected] of Object.entries(files)) {
      const bytes = await previewInputFile(join(directory, name), Buffer.byteLength(expected));
      if (!bytes.equals(Buffer.from(expected))) hostRefusal('input-readback');
    }
  }
}
