import { mkdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export async function copyFiles(source, destination, files) {
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, file), target);
  }
}
