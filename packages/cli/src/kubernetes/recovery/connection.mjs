import { resolve } from 'node:path';
import { execute } from '../../recovery/execute.mjs';

export function namespaceName(value) {
  if (typeof value !== 'string' || value.length > 63 || !/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) throw new Error('Expected a Kubernetes namespace DNS label');
  return value;
}
export async function connection(kubeconfig, context) {
  if (!kubeconfig || !/^kind-fogd-[a-z0-9][a-z0-9-]*$/.test(context || '')) throw new Error('Kubernetes recovery currently requires an explicit local fogd kind kubeconfig and context');
  const cluster = context.slice(5), base = ['--kubeconfig', resolve(kubeconfig), '--context', context];
  const command = (args, options) => execute('kubectl', [...base, ...args], options);
  async function json(args) {
    const value = await command([...args, '-o', 'json']);
    try { return JSON.parse(value); } catch { throw new Error('Unreadable Kubernetes JSON; private values are withheld'); }
  }
  const nodes = (await json(['get', 'nodes'])).items;
  const expected = [`${cluster}-control-plane`, `${cluster}-worker`, `${cluster}-worker2`].sort();
  if (JSON.stringify(nodes.map(n => n.metadata.name).sort()) !== JSON.stringify(expected)) throw new Error('Unexpected local kind node inventory');
  for (const name of expected) {
    const label = await execute('docker', ['inspect', name, '--format', '{{index .Config.Labels "io.x-k8s.kind.cluster"}}']);
    if (label.trim() !== cluster) throw new Error('Kubernetes target is not the declared local kind cluster');
  }
  return { command, json, nodes, cluster, base, kubeconfig: resolve(kubeconfig), context,
    apply: value => command(['apply', '-f', '-'], { inputText: JSON.stringify(value) }),
    create: value => command(['create', '-f', '-'], { inputText: JSON.stringify(value) }),
  };
}
export function readyNodes(nodes) {
  if (nodes.some(n => n.metadata.deletionTimestamp || !n.status.conditions.some(c => c.type === 'Ready' && c.status === 'True'))) throw new Error('Every source node must acknowledge Ready before recovery operations');
}
