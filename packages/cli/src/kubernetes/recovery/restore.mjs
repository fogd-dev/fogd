import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { writeJson } from '../../recovery/bundle.mjs';
import { verifyImageArchive } from './image-archive.mjs';
import { privateValues } from './private-config.mjs';
import { connection, namespaceName, readyNodes } from './connection.mjs';
import { verifyKubeBundle, restoredObjects, placementFor } from './bundle.mjs';
import { verifyStorage } from './storage.mjs';
import { restoreImages } from './images.mjs';
import { withHelper, restoreClaim, noPods } from './pods.mjs';

async function configuration(dir, objects) {
  await writeJson(join(dir, 'manifests.json'), objects.desired);
  await writeJson(join(dir, 'secrets.json'), objects.secrets);
  await writeJson(join(dir, 'stopped.json'), objects.stopped);
  await writeJson(join(dir, 'topology.json'), objects.topology);
  const values = privateValues(objects.secrets);
  const env = { FOGD_TOPOLOGY: 'kubernetes', FOGD_PROFILE: 'shared', FOGD_TLS: '1', FOGD_DEPLOY_TOKEN: '', FOGD_KUBE_NAMESPACE: objects.topology.namespace };
  for (const key of ['FOGD_ADMIN_USER', 'FOGD_ADMIN_PASSWORD', 'FOGD_GATEWAY_TOKEN']) env[key] = values[key];
  const controller = objects.desired.items.find(s => s.kind === 'StatefulSet' && s.metadata.name === 'controller');
  env.FOGD_BASE_DOMAIN = controller.spec.template.spec.containers[0].env.find(e => e.name === 'FOGD_BASE_DOMAIN').value;
  if (Object.values(env).some(v => /['\r\n]/.test(v))) throw new Error('Private configuration cannot be represented safely in this installation file');
  await writeFile(join(dir, 'installation.env'), Object.entries(env).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
}
export async function kubeRestore(directory, namespace, output, kubeconfig, context) {
  const source = resolve(directory), dir = resolve(output);
  const bundle = await verifyKubeBundle(source);
  await verifyImageArchive(join(source, 'images.tar'), bundle.manifest.images);
  namespaceName(namespace);
  if (bundle.stop.uncertain.length) console.warn(`Snapshot requires crash-recovery consideration for: ${bundle.stop.uncertain.join(', ')}`);
  if (namespace === bundle.manifest.namespace) throw new Error('Restore requires a different fresh namespace');
  const conn = await connection(kubeconfig, context); readyNodes(conn.nodes);
  const existing = (await conn.json(['get', 'namespaces'])).items;
  if (existing.some(n => n.metadata.name === namespace)) throw new Error('Restore refuses an existing namespace');
  await verifyStorage(conn, bundle.manifest.pvc);
  const placement = placementFor(bundle, conn.nodes);
  await restoreImages(conn, bundle, join(source, 'images.tar'));
  const objects = restoredObjects(bundle, namespace);
  await mkdir(dir, { mode: 0o700 });
  const started = Date.now();
  await configuration(dir, objects);
  const ns = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: { 'app.kubernetes.io/part-of': 'fogd' } } };
  await writeJson(join(dir, 'namespace.json'), ns);
  await conn.create(ns);
  await conn.create(objects.secrets);
  for (const service of objects.desired.items.filter(r => r.kind === 'Service')) await conn.create(service);
  for (const claim of bundle.manifest.pvc) {
    console.log(`Restoring ${claim.name}`);
    await conn.create({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: claim.name, namespace }, spec: claim.spec });
    await withHelper(conn, namespace, claim.name, placement[claim.name], bundle.topology.images.runtime, false, exec => restoreClaim(exec, join(source, `${claim.name}.tar`)));
  }
  await noPods(conn, namespace);
  await conn.apply({ apiVersion: 'v1', kind: 'List', items: objects.stopped.items.filter(r => r.kind === 'StatefulSet') });
  await writeJson(join(dir, 'restored.json'), { format: 'fogd-kube-restored-v1', namespace, source: bundle.manifest.namespace, cluster: conn.cluster, context, kubeconfig: conn.kubeconfig, images: bundle.manifest.images, placement, durationMs: Date.now() - started, writersStarted: false });
  console.log(`Restored ${namespace} onto fresh claims; all writers remain stopped. Start MinIO, then fleets/controller, then gateway using ${join(dir, 'manifests.json')}.`);
}
