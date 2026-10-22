import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { privateRuntimeSubnet } from '@fogd/platform/runtime-policy';
import { requestedRecoveryRuntime } from './recovery-selection.mjs';

export async function recoveryOptions(values) {
  const selection = { runtime: values.runtime, expectedIdentity: values['expected-identity'] };
  const entry = requestedRecoveryRuntime(selection);
  if (values['network-plan'] === undefined) return selection;
  if (!entry) throw new Error('Recovery network selection requires an explicit runtime family');
  selection.networks = await readNetworkPlan(values['network-plan']);
  return selection;
}

async function readNetworkPlan(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid network plan file');
    const buffer = Buffer.alloc(4097), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new Error('Network plan changed while reading');
    const networks = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!networks || !isDeepStrictEqual(Object.keys(networks).sort(), ['control', 'fleet-1', 'fleet-2']) ||
      !Object.values(networks).every(privateRuntimeSubnet) || new Set(Object.values(networks)).size !== 3) throw new Error('Invalid network placement');
    return networks;
  } catch {
    throw new Error('Cannot read network plan: use a regular JSON file of at most 4096 bytes with distinct control, fleet-1 and fleet-2 private 10.x.x.0/24 subnets');
  } finally { await file?.close(); }
}
