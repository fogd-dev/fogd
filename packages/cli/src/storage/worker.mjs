// Serialized into the verified image. Only directory/device and filesystem
// metadata are read; application files, environment and network are unused.
export async function sampleSpace(paths) {
  const { lstatSync, statfsSync } = await import('node:fs');
  const devices = new Map(), filesystems = [], mounts = [];
  for (const [index, path] of paths.entries()) {
    const directory = lstatSync(path, { bigint: true });
    if (!directory.isDirectory()) throw new Error('Not a volume directory');
    const device = directory.dev.toString();
    if (!devices.has(device)) {
      const stat = statfsSync(path, { bigint: true }), id = `filesystem-${devices.size + 1}`;
      devices.set(device, id);
      filesystems.push({ id, device, type: stat.type.toString(), observedAt: new Date().toISOString(),
        blockBytes: stat.bsize.toString(), fragmentBytes: (stat.frsize ?? 0n).toString(), blocks: stat.blocks.toString(), freeBlocks: stat.bfree.toString(), availableBlocks: stat.bavail.toString(),
        inodes: stat.files.toString(), freeInodes: stat.ffree.toString() });
    }
    mounts.push({ index, filesystem: devices.get(device) });
  }
  return { mounts, filesystems };
}
