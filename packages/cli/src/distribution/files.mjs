import { constants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
export { ordinaryDirectory, transferFiles, transferFingerprint } from './bootstrap.mjs';

export async function copyTransferFile(source, destination, limit = 4 * 1024 ** 2) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await input.stat();
    if (!info.isFile() || info.size > limit) throw new Error('Transfer source must be a bounded regular file');
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const output = await open(destination, 'wx', 0o600);
    try {
      let bytes = 0;
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        bytes += chunk.length; if (bytes > limit) throw new Error('Transfer source grew beyond its copy limit');
        await output.writeFile(chunk);
      }
      await output.sync();
    }
    finally { await output.close(); }
  } finally { await input.close(); }
}
