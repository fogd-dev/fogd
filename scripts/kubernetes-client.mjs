import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { run, stackRoot } from '../packages/cli/src/local.mjs';

export async function kubernetesClient(directory) {
  const root = resolve(directory), name = root.split('/').at(-1);
  assert.match(name, /^m9[a-z0-9-]*$/);
  assert.ok(root.startsWith(join(stackRoot, '.fogd') + '/'));
  const cluster = `fogd-${name}`, context = `kind-${cluster}`;
  const base = ['--kubeconfig', join(root, 'kubeconfig'), '--context', context];
  const kubectl = (args, capture = false) => run('kubectl', [...base, ...args], { capture });
  assert.equal((await kubectl(['config', 'current-context'], true)).trim(), context);
  const nodes = JSON.parse(await kubectl(['get', 'nodes', '-o', 'json'], true)).items.map(n => n.metadata.name).sort();
  assert.deepEqual(nodes, [`${cluster}-control-plane`, `${cluster}-worker`, `${cluster}-worker2`]);
  for (const node of nodes) {
    const label = await run('docker', ['inspect', node, '--format', '{{index .Config.Labels "io.x-k8s.kind.cluster"}}'], { capture: true });
    assert.equal(label.trim(), cluster);
  }
  const installation = join(root, 'installation');
  const topology = JSON.parse(await readFile(join(installation, 'topology.json'), 'utf8'));
  assert.ok(topology.namespace === cluster || topology.namespace.startsWith(cluster + '-'));
  assert.match(topology.namespace, /^[a-z0-9-]+$/);
  const env = { ...process.env, ...parseEnv(await readFile(join(installation, 'installation.env'), 'utf8')), FOGD_ENV_FILE: join(installation, 'installation.env') };
  const kube = (args, capture = false) => kubectl(['-n', topology.namespace, ...args], capture);
  function forward(service, localPort, remotePort) {
    const child = spawn('kubectl', [...base, '-n', topology.namespace, 'port-forward', '--address', '127.0.0.1', `service/${service}`, `${localPort}:${remotePort}`], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', error => console.error(`Port forward failed: ${error.message}`));
    return child;
  }
  return { root, cluster, installation, topology, env, kube, kubectl, forward };
}
