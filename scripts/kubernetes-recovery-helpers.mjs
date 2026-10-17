import { counts } from '../packages/cli/src/kubernetes/recovery/contract.mjs';
export async function startInstallation(conn, namespace, desired) {
  for (const group of [['minio'], ['slot-1', 'slot-2', 'controller'], ['workerd']]) {
    for (const name of group) await conn.command(['-n', namespace, 'scale', `statefulset/${name}`, `--replicas=${counts[name]}`]);
    for (const name of group) await conn.command(['-n', namespace, 'wait', `--for=jsonpath={.status.readyReplicas}=${counts[name]}`, `statefulset/${name}`, '--timeout=180s']);
  }
  await conn.apply(desired);
}
