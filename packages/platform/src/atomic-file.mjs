import { constants } from 'node:fs';
import { mkdir, open, rename, link, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeAtomicFile(path, content, { mode = 0o600, createOnly = false, createDirectory = true } = {}) {
  if (createDirectory) await mkdir(dirname(path), { recursive: true });
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', mode);
    try { await file.chmod(mode); await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    if (createOnly) { await link(temporary, path); await unlink(temporary); }
    else await rename(temporary, path);
    await directory.sync();
  } finally { await directory.close(); }
}
