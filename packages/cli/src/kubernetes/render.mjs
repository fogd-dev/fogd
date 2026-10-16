import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { configEnv, stackRoot } from '../local.mjs';
import { kubeSettings, privateSettings } from './config.mjs';
import { resource } from './resources.mjs';
import { bucket, fleet, platform } from './workloads.mjs';

export function manifests(settings) {
  return { apiVersion: 'v1', kind: 'List', items: [
    ...bucket(settings), ...settings.slots.flatMap(slot => fleet(settings, slot)),
    ...platform(settings, 'controller'), ...platform(settings, 'workerd'),
  ] };
}
export function secrets(settings) {
  return { apiVersion: 'v1', kind: 'List', items: [
    resource('Secret', 'fogd-private', settings.namespace, { type: 'Opaque', stringData: privateSettings(settings) }),
    resource('Secret', 'fogd-tls', settings.namespace, { type: 'Opaque', stringData: { 'keypair.json': JSON.stringify(settings.keypair) } }),
  ] };
}
export async function render(directory, certFile, keyFile) {
  const output = resolve(directory), privateRoot = join(stackRoot, '.fogd');
  const within = relative(privateRoot, output);
  if (!within || within.startsWith('..') || resolve(privateRoot, within) !== output) throw new Error('Write Kubernetes installation files into a new directory under .fogd/');
  const env = await configEnv();
  const settings = kubeSettings(env, { cert: await readFile(resolve(certFile), 'utf8'), key: await readFile(resolve(keyFile), 'utf8') });
  await mkdir(output, { mode: 0o700 });
  const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await save('namespace.json', { apiVersion: 'v1', kind: 'Namespace', metadata: { name: settings.namespace, labels: { 'app.kubernetes.io/part-of': 'fogd' } } });
  await save('manifests.json', manifests(settings));
  await save('secrets.json', secrets(settings));
  const keys = /^(FOGD_(PROFILE|TLS|DEPLOY_TOKEN|ADMIN_USER|ADMIN_PASSWORD|GATEWAY_TOKEN|BASE_DOMAIN|SERVER|URL|BUCKET|BUCKET_REGION|BUCKET_USER|BUCKET_PASSWORD|MAX_.*|CELLD_.*|MINIO_.*|KUBE_.*|SLOT_[12]_PREFIX))$/;
  const selected = Object.fromEntries(Object.entries(env).filter(([key]) => keys.test(key)));
  selected.FOGD_TOPOLOGY = 'kubernetes';
  if (Object.values(selected).some(value => /['\r\n]/.test(value))) throw new Error('Installation settings must be single-line values without single quotes');
  await writeFile(join(output, 'installation.env'), Object.entries(selected).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  await save('topology.json', { format: 'fogd-kubernetes-experimental-v1', namespace: settings.namespace, images: settings.images, pullPolicy: settings.pullPolicy, slots: settings.slots, configurationChanges: ['Replica IDs and addresses are ordinal Service names', 'Public ports and bind addresses are configured outside these ClusterIP manifests', 'Bucket endpoint is the in-namespace MinIO Service'] });
  console.log(`Experimental Kubernetes manifests written to ${output}. No cluster was modified. Recovery requires a Kubernetes adapter; fogd backup does not cover PVCs.`);
}
