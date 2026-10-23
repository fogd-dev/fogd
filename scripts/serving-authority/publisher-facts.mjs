// Serialized into the cached image; reads only executable, mount and fixture facts.
export async function publisherFacts(executable) {
  const { createHash } = await import('node:crypto');
  const { readFile, readdir, lstat } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const files = [];
  for (const name of (await readdir('/authority')).sort()) {
    const path = `/authority/${name}`, stat = await lstat(path);
    if (!stat.isFile() || stat.size > 4096) throw new Error('Unexpected authority fixture file');
    files.push({ name, bytes: stat.size, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
  const mount = (await readFile('/proc/self/mountinfo', 'utf8')).split('\n').find(row => row.split(' ')[4] === '/authority');
  if (!mount) throw new Error('Authority mount metadata missing');
  return { workerdVersion: execFileSync(executable.path, ['--version'], { encoding: 'utf8' }).trim(), workerdExecutable: executable.path, workerdBinarySha256: executable.sha256,
    filesystem: mount.split(' - ')[1].split(' ')[0], files };
}
