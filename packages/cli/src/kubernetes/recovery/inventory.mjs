import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readJson } from '../../recovery/bundle.mjs';
import { verifyImages, verifyRunningImages } from './images.mjs';
import { verifyStorage } from './storage.mjs';
import { validateShape } from './shape.mjs';
import { namespaceName, readyNodes } from './connection.mjs';

import { counts, claims } from './contract.mjs';
const sorted = values => [...values].sort();
export function checkWriters(objects, sets) {
  const expected = Object.entries(counts).flatMap(([name, count]) => Array.from({ length: count }, (_, i) => `${name}-${i}`));
  if (objects.controllers.length) throw new Error('Unexpected controller in snapshot namespace');
  for (const pod of objects.pods) {
    const owner = pod.metadata.ownerReferences?.find(o => o.controller);
    if (!expected.includes(pod.metadata.name) || pod.metadata.deletionTimestamp || !sets.some(s => owner?.kind === 'StatefulSet' && owner.uid === s.metadata.uid && pod.metadata.name.startsWith(s.metadata.name + '-'))) throw new Error('Unexpected or terminating pod in snapshot namespace');
  }
  if (!isDeepStrictEqual(sorted(objects.pods.map(p => p.metadata.name)), sorted(expected))) throw new Error('Snapshot requires the complete live pod inventory');
}
export async function inventory(conn, installation) {
  const topology = await readJson(join(installation, 'topology.json'));
  namespaceName(topology.namespace);
  if (topology.format !== 'fogd-kubernetes-experimental-v1' || topology.pullPolicy !== 'Never') throw new Error('Only the generated local kind topology is supported');
  readyNodes(conn.nodes);
  const desired = await readJson(join(installation, 'manifests.json'));
  validateShape(desired, topology);
  const ns = ['-n', topology.namespace];
  // Diff output can contain private settings; execute captures it without displaying it.
  await verifyDesired(conn, ns, installation);
  const live = await conn.json([...ns, 'get', 'statefulsets,services,persistentvolumeclaims,pods,deployments,replicasets,daemonsets,jobs,cronjobs,secrets']);
  const sets = live.items.filter(r => r.kind === 'StatefulSet');
  if (!isDeepStrictEqual(sorted(sets.map(s => s.metadata.name)), sorted(Object.keys(counts))) || sets.some(s => s.spec.replicas !== counts[s.metadata.name] || s.spec.updateStrategy.type !== 'OnDelete')) throw new Error('Unexpected StatefulSet ownership or replica counts');
  const pods = live.items.filter(r => r.kind === 'Pod');
  checkWriters({ pods, controllers: live.items.filter(r => ['Deployment', 'ReplicaSet', 'DaemonSet', 'Job', 'CronJob'].includes(r.kind)) }, sets);
  const pvc = live.items.filter(r => r.kind === 'PersistentVolumeClaim');
  if (!isDeepStrictEqual(sorted(pvc.map(p => p.metadata.name)), claims) || pvc.some(p => p.status.phase !== 'Bound')) throw new Error('Unexpected or unbound claim inventory');
  await verifyStorage(conn, pvc);
  const privateObjects = live.items.filter(r => r.kind === 'Secret');
  if (!isDeepStrictEqual(sorted(privateObjects.map(s => s.metadata.name)), ['fogd-private', 'fogd-tls'])) throw new Error('Unexpected Secret inventory');
  const services = live.items.filter(r => r.kind === 'Service');
  if (!isDeepStrictEqual(sorted(services.map(s => s.metadata.name)), sorted(desired.items.filter(r => r.kind === 'Service').map(s => s.metadata.name)))) throw new Error('Unexpected Service inventory');
  const placement = Object.fromEntries(pods.map(p => [`data-${p.metadata.name}`, p.spec.nodeName]).filter(([name]) => claims.includes(name)));
  const images = await verifyImages(conn, topology.images);
  await verifyRunningImages(pods, topology.images, images);
  return { topology, desired, sets, pods, pvc, placement, images, secrets: { apiVersion: 'v1', kind: 'List', items: privateObjects.map(s => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name: s.metadata.name, namespace: topology.namespace }, type: s.type, data: s.data })) } };
}


async function verifyDesired(conn, namespaceArgs, installation) {
  try { await conn.command([...namespaceArgs, 'diff', '-f', join(installation, 'manifests.json')]); }
  catch (error) {
    if (error.exitCode === 1) throw new Error('Live Kubernetes configuration differs from installation manifests; source was not stopped');
    throw error;
  }
}
