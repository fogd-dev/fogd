import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readJson, fingerprint } from '../../recovery/bundle.mjs';
import { counts, claims } from './contract.mjs';
import { namespaceName } from './connection.mjs';
import { uncertainStops } from './stop-evidence.mjs';
import { validateClaims, validatePrivateConfiguration } from './private-config.mjs';
import { validateShape } from './shape.mjs';

export async function verifyKubeBundle(directory) {
  const manifest = await readJson(join(directory, 'manifest.json'));
  const expected = ['manifests.json', 'secrets.json', 'topology.json', 'images.tar', 'started.json', 'stop.json', ...claims.map(c => `${c}.tar`)].sort();
  if (manifest.format !== 'fogd-kube-stopped-v1' || !isDeepStrictEqual(Object.keys(manifest.files || {}).sort(), expected)) throw new Error('Incomplete Kubernetes snapshot');
  for (const name of expected) if (!isDeepStrictEqual(await fingerprint(join(directory, name)), manifest.files[name])) throw new Error(`Kubernetes snapshot checksum mismatch: ${name}`);
  const topology = await readJson(join(directory, 'topology.json'));
  const desired = await readJson(join(directory, 'manifests.json'));
  const secrets = await readJson(join(directory, 'secrets.json'));
  namespaceName(manifest.namespace); validateShape(desired, topology);
  validateInventory(manifest, topology, secrets);
  validateClaims(manifest.pvc); validatePrivateConfiguration(secrets);
  const started = await readJson(join(directory, 'started.json')), stop = await readJson(join(directory, 'stop.json'));
  validateStop(started, stop, manifest);
  return { manifest, topology, desired, secrets, stop };
}
export function restoredObjects(bundle, namespace) {
  namespaceName(namespace);
  const desired = structuredClone(bundle.desired), secrets = structuredClone(bundle.secrets);
  for (const item of [...desired.items, ...secrets.items]) item.metadata.namespace = namespace;
  const stopped = structuredClone(desired);
  for (const item of stopped.items) if (item.kind === 'StatefulSet') item.spec.replicas = 0;
  return { desired, secrets, stopped, topology: { ...bundle.topology, namespace } };
}
export function placementFor(bundle, nodes) {
  const available = nodes.map(n => n.metadata.name).filter(n => !n.endsWith('-control-plane')).sort();
  if (available.length !== 2) throw new Error('Recovery requires two available worker nodes');
  const placement = Object.fromEntries(bundle.manifest.pvc.map(claim => {
    if (!/-(worker|worker2)$/.test(claim.node)) throw new Error('Snapshot has unsupported claim placement');
    return [claim.name, claim.node.endsWith('-worker2') ? available[1] : available[0]];
  }));
  for (const slot of ['slot-1', 'slot-2']) if (placement[`data-${slot}-0`] === placement[`data-${slot}-1`]) throw new Error('Restore would co-locate fleet claims');
  return placement;
}

function validateInventory(manifest, topology, secrets) {
  if (topology.namespace !== manifest.namespace || topology.pullPolicy !== 'Never') throw new Error('Inconsistent Kubernetes snapshot topology');
  if (!isDeepStrictEqual(Object.keys(manifest.images || {}).sort(), Object.values(topology.images).sort()) || Object.values(manifest.images).some(id => !/^sha256:[a-f0-9]{64}$/.test(id))) throw new Error('Invalid snapshot image inventory');
  if (!isDeepStrictEqual(manifest.pvc?.map(c => c.name).sort(), claims)) throw new Error('Invalid snapshot claim inventory');
  if (secrets.kind !== 'List' || !isDeepStrictEqual(secrets.items.map(s => s.metadata.name).sort(), ['fogd-private', 'fogd-tls']) || secrets.items.some(s => s.kind !== 'Secret' || s.metadata.namespace !== manifest.namespace)) throw new Error('Invalid snapshot private configuration');
}

function validateStop(started, stop, manifest) {
  const names = Object.entries(counts).flatMap(([name, count]) => Array.from({length:count}, (_, i) => `${name}-${i}`)).sort();
  if (started.namespace !== manifest.namespace || stop.complete !== true || !isDeepStrictEqual(started.images, manifest.images)) throw new Error('Snapshot does not record complete quiescence');
  if (!Array.isArray(stop.exits) || !isDeepStrictEqual(stop.exits.map(p => p.name).sort(), names) || stop.exits.some(p => typeof p.uid !== 'string' || !Array.isArray(p.containers))) throw new Error('Snapshot has incomplete termination evidence');
  if (!isDeepStrictEqual(stop.uncertain, uncertainStops(stop.exits))) throw new Error('Snapshot termination classification is inconsistent');
}
