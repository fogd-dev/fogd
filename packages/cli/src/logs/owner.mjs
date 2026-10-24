import { readFile } from 'node:fs/promises';
import { runObserver } from '../observe/runner.mjs';
import { isIPv4 } from 'node:net';
import { json, projectContainers } from '../recovery/docker.mjs';
import { logContainer, ownedLogNetwork } from './scope.mjs';

export async function logOwner(installation, selection) {
  const { config } = installation;
  if (!Object.hasOwn(config.services.controller.networks, 'control') || config.services.controller.environment.S3_ENDPOINT !== 'http://minio:9000') throw new Error('Replica log ownership network is unavailable');
  const network = await ownedLogNetwork(installation, 'control');
  const storage = await storageScope(installation, network);
  const env = Object.fromEntries(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'FOGD_BUCKET', 'S3_ENDPOINT', 'FOGD_SLOTS'].map(key => [key, config.services.controller.environment[key]]));
  const code = (await readFile(new URL('./owner-worker.mjs', import.meta.url), 'utf8')) + '\nawait main();\n';
  const result = await runObserver(installation, { network: network.name, code,
    input: { env, profile: installation.policy, expected: { slot: selection.fleet.id, app: selection.app }, address: storage.address }, timeoutMs: 15000 });
  return { matched: result?.owner === 'matched', storage };
}

async function storageScope(installation, network) {
  const [image] = await json(['image', 'inspect', installation.entry.storageImage]);
  const storage = logContainer(installation, 'minio', await projectContainers(installation.project), image);
  const endpoint = storage.NetworkSettings?.Networks?.[network.name];
  if (!storage.State.Running || storage.State.Paused || storage.State.Restarting || endpoint?.NetworkID !== network.id || !isIPv4(endpoint?.IPAddress)) throw new Error('Replica log ownership storage is unavailable');
  return { id: storage.Id, startedAt: storage.State.StartedAt, address: endpoint.IPAddress, network: network.id };
}
