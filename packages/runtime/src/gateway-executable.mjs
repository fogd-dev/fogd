import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const gatewayExecutable = fileURLToPath(new URL('../node_modules/workerd/bin/workerd', import.meta.url));
// npm may leave a Node shim at this path. A shim's close does not establish that
// its workerd descendant stopped, so this family requires the direct native ELF.
// Image/source provenance is still checked independently by the host coordinator.
export async function assertGatewayExecutable(path = gatewayExecutable) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat(), header = Buffer.alloc(20);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (!stat.isFile() || !(stat.mode & 0o111) || bytesRead !== header.length ||
        !header.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) ||
        ![2, 3].includes(header.readUInt16LE(16)) || header.readUInt16LE(18) !== 183) throw new Error();
    } finally { await file.close(); }
  } catch {
    throw Object.assign(new Error('Durable gateway requires the direct Linux arm64 native executable; keep ingress stopped'), { code: 'GATEWAY_EXECUTABLE_REFUSED' });
  }
}
