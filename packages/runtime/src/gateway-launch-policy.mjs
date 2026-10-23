import { constants } from 'node:fs';
import { open, lstat, chmod, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

// Fresh installation only: an existing empty directory owned by this user gets
// one exclusively created file; retained or partial stores are refused, never
// replaced. Emptiness is not physical freshness; the caller proves that.
export async function writeGatewayLaunchPolicy(directory, input) {
  const policy = validateGatewayLaunchPolicy(input), text = JSON.stringify(policy) + '\n';
  try {
    if (Buffer.byteLength(text) > maxGatewayPolicyBytes) throw refused();
    const stat = await lstat(directory);
    if (!stat.isDirectory() || (stat.mode & 0o022) || stat.uid !== process.geteuid() || (await readdir(directory)).length) throw refused();
    await chmod(directory, 0o755);
    const file = await open(join(directory, 'policy.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { await file.chmod(0o644); await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    return { installation: policy.policy.installation, sha256: createHash('sha256').update(text).digest('hex') };
  } catch {
    throw Object.assign(new Error('Could not install the fresh gateway launch policy; keep ingress stopped'), { code: 'GATEWAY_POLICY_WRITE_FAILED' });
  }
}
