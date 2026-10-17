import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, link, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { kubernetesClient } from './kubernetes-client.mjs';
import { connection } from '../packages/cli/src/kubernetes/recovery/connection.mjs';
import { helperPod } from '../packages/cli/src/kubernetes/recovery/pods.mjs';
import { run, stackRoot } from '../packages/cli/src/local.mjs';
import { platformClient } from './platform-client.mjs';
import { expect } from './guestbook-browser.mjs';
import { startInstallation } from './kubernetes-recovery-helpers.mjs';

const cluster = await kubernetesClient(process.argv[2] || '.fogd/m9final2');
const conn = await connection(join(cluster.root, 'kubeconfig'), `kind-${cluster.cluster}`);
const suffix = process.argv[3] ? `-${process.argv[3]}` : '';
assert.match(suffix, /^(?:-[a-z0-9-]+)?$/);
const testSuffix = suffix + (process.argv[4] ? `-${process.argv[4]}` : '');
assert.match(testSuffix, /^(?:-[a-z0-9-]+)?$/);
const target = `${cluster.cluster}-restored${suffix}`, source = cluster.topology.namespace;
const snapshot = `snapshot${suffix}`, restoredDirectory = `restored${suffix}`;
const cli = join(stackRoot, 'packages/cli/bin/fogd.js'), options = ['--kubeconfig', conn.kubeconfig, '--context', conn.context];
const damaged = join(cluster.root, `damaged-snapshot${testSuffix}`); await mkdir(damaged, { mode: 0o700 });
for (const name of await readdir(join(cluster.root, snapshot))) {
  if (name !== 'data-minio-0.tar') await link(join(cluster.root, snapshot, name), join(damaged, name));
}
await writeFile(join(damaged, 'data-minio-0.tar'), 'corrupt', { mode: 0o600 });
const refusedNamespace = `${cluster.cluster}-corrupt-refused${testSuffix}`;
await assert.rejects(run(process.execPath, [cli, 'kube', 'restore', damaged, '--namespace', refusedNamespace, '--output', join(cluster.root, `corrupt-refused${testSuffix}`), ...options]), /exited/);
assert.ok(!(await conn.json(['get', 'namespaces'])).items.some(n => n.metadata.name === refusedNamespace));
const versions = async () => (await conn.json(['-n', target, 'get', 'statefulsets,services,secrets,pvc'])).items.map(r => ({kind:r.kind,name:r.metadata.name,uid:r.metadata.uid,version:r.metadata.resourceVersion}));
const unchanged = await versions();
await assert.rejects(run(process.execPath, [cli, 'kube', 'restore', join(cluster.root, snapshot), '--namespace', target, '--output', join(cluster.root, `occupied-refused${testSuffix}`), ...options]), /exited/);
assert.deepEqual(await versions(), unchanged);
const node = (await conn.json(['-n', target, 'get', 'pod', 'controller-0'])).spec.nodeName;
const foreign = helperPod(target, 'data-controller-0', node, cluster.topology.images.runtime, false);
await conn.create(foreign);
try {
  await conn.command(['-n', target, 'wait', '--for=condition=Ready', `pod/${foreign.metadata.name}`, '--timeout=120s']);
  await assert.rejects(run(process.execPath, [cli, 'kube', 'backup', join(cluster.root, restoredDirectory), join(cluster.root, `foreign-refused${testSuffix}`), ...options]), /exited/);
  await assert.rejects(access(join(cluster.root, `foreign-refused${testSuffix}`)));
} finally { await conn.command(['-n', target, 'delete', 'pod', foreign.metadata.name, '--wait=true', '--timeout=120s']); }
const desired = JSON.parse(await readFile(join(cluster.installation, 'manifests.json'), 'utf8'));
await startInstallation(conn, source, desired);
const downNode = `${cluster.cluster}-worker2`, incomplete = join(cluster.root, `node-interrupted${testSuffix}`);
let interrupted = false, output = '', nodeStop;
const child = spawn(process.execPath, [cli, 'kube', 'backup', cluster.installation, incomplete, ...options], { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', chunk => {
  output += chunk;
  if (!interrupted && output.includes('Stopping Kubernetes installation')) { interrupted = true; nodeStop = run('docker', ['stop', '-t', '0', downNode]); }
});
child.stderr.on('data', chunk => { output += chunk; });
const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
try {
  await nodeStop;
  assert.ok(interrupted); assert.notEqual(code, 0); assert.match(output, /did not acknowledge termination/);
  assert.ok((await conn.json(['-n', source, 'get', 'pods'])).items.some(p => p.metadata.deletionTimestamp));
  await assert.rejects(access(join(incomplete, 'manifest.json')));
} finally { if (interrupted) await run('docker', ['start', downNode]); }
await conn.command(['wait', '--for=condition=Ready', `node/${downNode}`, '--timeout=180s']);
await startInstallation(conn, source, desired);
const forwards = [cluster.forward('workerd', 8787, 8080, source), cluster.forward('workerd', 8797, 8080, target)];
try {
  const local = await platformClient({ ...cluster.env, FOGD_URL: 'https://127.0.0.1:8787' });
  const restored = await platformClient({ ...cluster.env, FOGD_URL: 'https://127.0.0.1:8797' });
  for (const client of [local, restored]) await expect.poll(async () => { try { return (await client.appRequest('notebook', '/api/entries')).status; } catch { return 0; } }, { timeout: 180000 }).toBe(200);
  const original = await (await local.appRequest('notebook', '/api/entries')).json();
  const recovered = await (await restored.appRequest('notebook', '/api/entries')).json();
  assert.equal(recovered.count, original.count + 1);
  assert.ok(!original.entries.some(e => e.id.startsWith('restored-')));
  assert.ok(recovered.entries.some(e => e.id.startsWith('restored-')));
  console.log('PASS: corrupted archive refused before namespace creation, foreign writable claim consumer refused before stopping, lost node during stop leaves incomplete snapshot and terminating pod, source/restored namespace data remain isolated');
} finally { for (const child of forwards) child.kill('SIGTERM'); }
