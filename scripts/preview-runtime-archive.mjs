import { open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { posix } from 'node:path';

function header(name, size, mode, type, link = '') {
  if (name.length > 100 || !/^[A-Za-z0-9@._/-]+$/.test(name) || name.startsWith('/') || name.split('/').includes('..')) throw new Error('Invalid preview archive member');
  const bytes = Buffer.alloc(512);
  const field = (offset, length, value) => bytes.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
  bytes.write(name); field(100, 8, mode); field(108, 8, 0); field(116, 8, 0); field(124, 12, size); field(136, 12, 0);
  bytes.fill(32, 148, 156); bytes.write(type, 156); bytes.write(link, 157, 100); bytes.write('ustar\0', 257); bytes.write('00', 263);
  bytes.write([...bytes].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return bytes;
}

// Only generated product paths enter this writer. Directories come last so
// creating children cannot replace their fixed metadata during image unpacking.
export async function writePreviewArchive(destination, members) {
  const output = await open(destination, 'wx', 0o600), directories = new Set();
  try {
    for (const [path, input] of [...members].sort(([a], [b]) => a.localeCompare(b))) {
      let parent = posix.dirname(path);
      while (parent !== '.') { directories.add(parent); parent = posix.dirname(parent); }
      if (input.link) { await output.writeFile(header(path, 0, 0o777, '2', input.link)); continue; }
      const size = input.bytes ? input.bytes.length : (await stat(input.source)).size;
      await output.writeFile(header(path, size, input.mode || 0o644, '0'));
      let copied = 0;
      const chunks = input.bytes ? [input.bytes] : createReadStream(input.source);
      for await (const chunk of chunks) { copied += chunk.length; if (copied > size) throw new Error('Preview archive input grew'); await output.writeFile(chunk); }
      if (copied !== size) throw new Error('Preview archive input changed');
      if (size % 512) await output.writeFile(Buffer.alloc(512 - size % 512));
    }
    for (const path of [...directories].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))) await output.writeFile(header(path + '/', 0, 0o755, '5'));
    await output.writeFile(Buffer.alloc(1024)); await output.sync();
  } finally { await output.close(); }
}
