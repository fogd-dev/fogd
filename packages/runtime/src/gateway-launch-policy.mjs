import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { durableGatewayConfig } from './gateway-durable-config.mjs';

export const gatewayPolicyDirectory = '/var/lib/fogd-gateway';
export const gatewayAuthorityDirectory = '/var/lib/fogd-routes';
export const maxGatewayPolicyBytes = 16384;
const refused = () => Object.assign(new Error('Durable gateway requires its independently installed launch policy; keep ingress stopped'), { code: 'GATEWAY_POLICY_REFUSED' });

export function validateGatewayLaunchPolicy(input) {
  try {
    if (!input || Object.keys(input).sort().join(',') !== 'policy,schema,slots' || input.schema !== 1 ||
      !isDeepStrictEqual(input.policy?.slots, ['slot-1', 'slot-2']) || !isDeepStrictEqual(input.slots,
        ['slot-1', 'slot-2'].map(id => ({ id, nodes: [`${id}-a`, `${id}-b`] })))) throw refused();
    durableGatewayConfig({ ...input, authorityPath: gatewayAuthorityDirectory, listen: '*:8080' });
    return structuredClone(input);
  } catch { throw refused(); }
}

// This mount is independent of public route data. File checks do not prove mount
// provenance or authorize opening ingress; the host coordinator must do that.
export async function readGatewayLaunchPolicy(directory = gatewayPolicyDirectory) {
  try {
    const parent = await lstat(directory);
    if (!parent.isDirectory() || (parent.mode & 0o022)) throw refused();
    const file = await open(join(directory, 'policy.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o022) || stat.size > maxGatewayPolicyBytes) throw refused();
      const buffer = Buffer.alloc(maxGatewayPolicyBytes + 1); let bytes = 0;
      while (bytes < buffer.length) {
        const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
      }
      if (bytes > maxGatewayPolicyBytes) throw refused();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
      return validateGatewayLaunchPolicy(JSON.parse(text));
    } finally { await file.close(); }
  } catch { throw refused(); }
}
