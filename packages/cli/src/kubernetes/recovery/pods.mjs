import { verifyPlacement } from './storage.mjs';
import { randomUUID } from 'node:crypto';
import { fingerprint } from '../../recovery/bundle.mjs';

export async function noPods(conn, namespace, except) {
  const pods = (await conn.json(['-n', namespace, 'get', 'pods'])).items;
  if (pods.some(p => p.metadata.name !== except)) throw new Error('Snapshot namespace still contains a writer or unexpected pod');
}
export async function stop(conn, namespace) {
  for (const group of [['workerd', 'controller'], ['slot-1', 'slot-2'], ['minio']]) {
    await conn.command(['-n', namespace, 'scale', ...group.map(n => `statefulset/${n}`), '--replicas=0']);
    const deadline = Date.now() + 180000;
    while (true) {
      const pods = (await conn.json(['-n', namespace, 'get', 'pods'])).items;
      if (!pods.some(p => group.some(n => p.metadata.name.startsWith(n + '-')))) break;
      if (Date.now() >= deadline) throw new Error('Pods did not acknowledge termination; no complete snapshot can be claimed');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  await noPods(conn, namespace);
}
export function helperPod(namespace, claim, node, image, readonly) {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name: `fogd-recovery-${randomUUID().slice(0, 8)}`, namespace }, spec: {
    restartPolicy: 'Never', activeDeadlineSeconds: 900, terminationGracePeriodSeconds: 10, automountServiceAccountToken: false,
    nodeSelector: { 'kubernetes.io/hostname': node },
    containers: [{ name: 'archive', image, imagePullPolicy: 'Never', command: ['sleep', '900'],
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'], add: readonly ? [] : ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] } },
      resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '1', memory: '256Mi' } },
      volumeMounts: [{ name: 'data', mountPath: '/data', readOnly: readonly }] }],
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: claim, readOnly: readonly } }],
  } };
}
export async function withHelper(conn, namespace, claim, node, image, readonly, callback) {
  await noPods(conn, namespace);
  const pod = helperPod(namespace, claim, node, image, readonly), name = pod.metadata.name;
  await conn.create(pod);
  try {
    await conn.command(['-n', namespace, 'wait', '--for=condition=Ready', `pod/${name}`, '--timeout=180s']);
    const actual = await conn.json(['-n', namespace, 'get', 'pod', name]);
    if (actual.spec.nodeName !== node) throw new Error('Archive helper placement differs from required storage node');
    await verifyPlacement(conn, namespace, claim, node);
    await noPods(conn, namespace, name);
    await callback((args, options) => conn.command(['-n', namespace, 'exec', ...(options?.input ? ['-i'] : []), name, '--', ...args], options));
    await noPods(conn, namespace, name);
  } finally {
    await conn.command(['-n', namespace, 'delete', 'pod', name, '--wait=true', '--timeout=120s']);
  }
}
const archive = ['tar', '--sort=name', '--numeric-owner', '-cpf', '-', '-C', '/data', '.'];
export async function archiveClaim(exec, destination) {
  await exec(archive, { output: destination });
  const local = await fingerprint(destination);
  const remote = (await exec(['bash', '-o', 'pipefail', '-c', 'tar --sort=name --numeric-owner -cpf - -C /data . | sha256sum'])).trim().split(/\s+/)[0];
  if (local.sha256 !== remote) throw new Error('Archive stream does not match the source claim checksum');
  return local;
}
export async function restoreClaim(exec, source) {
  if ((await exec(['find', '/data', '-mindepth', '1', '-maxdepth', '1', '-print', '-quit'])).length) throw new Error('Restore requires an empty claim; existing files were not modified');
  await exec(['tar', '--numeric-owner', '-xpf', '-', '-C', '/data'], { input: source });
  await exec(['sync', '-f', '/data']);
  await exec(['tar', '--numeric-owner', '--compare', '-f', '-', '-C', '/data'], { input: source });
}
