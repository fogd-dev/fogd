import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, X509Certificate, randomBytes } from 'node:crypto';
import { kubernetesClient } from './kubernetes-client.mjs';
import { platformClient } from './platform-client.mjs';
import { accountsBrowser } from './accounts-browser.mjs';
import { expect } from './guestbook-browser.mjs';
import { run, stackRoot } from '../packages/cli/src/local.mjs';

const cluster = await kubernetesClient(process.argv[2] || '.fogd/m9a');
const certFile = resolve(process.argv[3] || '.fogd/m8b2-cert/server.pem');
await cluster.kubectl(['apply', '-f', join(cluster.installation, 'namespace.json')]);
await cluster.kubectl(['apply', '-f', join(cluster.installation, 'secrets.json')]);
await cluster.kubectl(['apply', '-f', join(cluster.installation, 'manifests.json')]);
for (const name of ['minio', 'controller', 'workerd', 'slot-1', 'slot-2']) await cluster.kube(['wait', `--for=jsonpath={.status.readyReplicas}=${name.startsWith('slot-') ? 2 : 1}`, `statefulset/${name}`, '--timeout=240s']);
const env = { ...cluster.env, FOGD_SERVER: 'https://127.0.0.1:8788', FOGD_URL: 'https://127.0.0.1:8787' };
const client = await platformClient(env);
let forwards = [];
function connect() { forwards = [cluster.forward('controller', 8788, 8082), cluster.forward('workerd', 8787, 8080)]; }
async function ready() { await expect.poll(async () => { try { return !!(await client.api('/v1/admin')); } catch { return false; } }, { timeout: 90000 }).toBe(true); }
function disconnect() { for (const child of forwards) child.kill('SIGTERM'); }
const cli = join(stackRoot, 'packages/cli/bin/fogd.js');
async function deploy(app, token, secretRevision) {
  await run(process.execPath, [cli, 'deploy'], { cwd: join(stackRoot, 'examples', app), env: { ...env, FOGD_DEPLOY_TOKEN: token } });
  const release = Object.values((await client.api('/v1/admin')).deployments).find(d => d.app === app && d.status === 'pending');
  assert.ok(release);
  const { csrf } = await client.api('/v1/admin');
  const approved = await client.api(`/v1/deployments/${release.id}/approve`, { method: 'POST', headers: { 'X-Fogd-CSRF': csrf }, body: JSON.stringify({ digest: release.digest, secretRevision }) });
  assert.equal(approved.status, 'active'); return approved;
}
async function replacePod(name) {
  const before = JSON.parse(await cluster.kube(['get', 'pod', name, '-o', 'json'], true));
  await cluster.kube(['delete', 'pod', name, '--wait=true', '--timeout=120s']);
  await cluster.kube(['wait', '--for=condition=Ready', `pod/${name}`, '--timeout=180s']);
  const after = JSON.parse(await cluster.kube(['get', 'pod', name, '-o', 'json'], true));
  assert.notEqual(after.metadata.uid, before.metadata.uid);
  assert.deepEqual(after.spec.volumes.filter(v => v.persistentVolumeClaim), before.spec.volumes.filter(v => v.persistentVolumeClaim));
}
connect();
let account;
try {
  await ready();
  assert.equal(Object.keys((await client.api('/v1/admin')).apps).length, 0, 'Use an empty Kubernetes installation');
  const token = JSON.parse(await run(process.execPath, [cli, 'admin', 'issue-token', 'Kubernetes fixture', 'accounts,notebook'], { env, capture: true }));
  const { csrf } = await client.api('/v1/admin');
  const secret = await client.api('/v1/apps/accounts/secrets', { method: 'PUT', headers: { 'X-Fogd-CSRF': csrf }, body: JSON.stringify({ BETTER_AUTH_SECRET: randomBytes(32).toString('hex') }) });
  await deploy('accounts', token.token, secret.revision); await deploy('notebook', token.token);
  const entry = { id: `kube-${Date.now()}`, title: 'Kubernetes state', body: 'D1/R2/DO persist across pod replacement' };
  assert.equal((await client.appRequest('notebook', '/api/entries', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) })).status, 200);
  const before = await (await client.appRequest('notebook', '/api/entries')).json();
  const cert = new X509Certificate(await readFile(certFile));
  const pin = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  account = await accountsBrowser(client.browserURL('accounts'), `kube-${Date.now()}@example.test`, 'Kubernetes account password', { args: [`--ignore-certificate-errors-spki-list=${pin}`] });
  await account.enroll();
  const claims = JSON.parse(await cluster.kube(['get', 'pvc', '-o', 'json'], true)).items.map(c => ({ name: c.metadata.name, uid: c.metadata.uid, volume: c.spec.volumeName }));
  for (const pod of ['slot-1-0', 'slot-2-0']) await replacePod(pod);
  // Remove the alternate replicas so gateway failover cannot hide stale addresses.
  await cluster.kube(['scale', 'statefulset/slot-1', 'statefulset/slot-2', '--replicas=1']);
  await cluster.kube(['wait', '--for=delete', 'pod/slot-1-1', 'pod/slot-2-1', '--timeout=120s']);
  await expect.poll(async () => { try { return (await client.appRequest('notebook', '/api/entries')).status; } catch { return 0; } }, { timeout: 90000 }).toBe(200);
  assert.deepEqual(await (await client.appRequest('notebook', '/api/entries')).json(), before);
  await account.ready('Session active');
  await cluster.kube(['scale', 'statefulset/slot-1', 'statefulset/slot-2', '--replicas=2']);
  for (const name of ['slot-1', 'slot-2']) await cluster.kube(['wait', '--for=jsonpath={.status.readyReplicas}=2', `statefulset/${name}`, '--timeout=180s']);
  disconnect();
  await replacePod('controller-0'); await replacePod('workerd-0');
  connect(); await ready();
  await account.ready('Session active');
  assert.deepEqual(await (await client.appRequest('notebook', '/api/entries')).json(), before);
  const afterClaims = JSON.parse(await cluster.kube(['get', 'pvc', '-o', 'json'], true)).items.map(c => ({ name: c.metadata.name, uid: c.metadata.uid, volume: c.spec.volumeName }));
  assert.deepEqual(afterClaims, claims);
  const pods = JSON.parse(await cluster.kube(['get', 'pod', '-o', 'json'], true)).items;
  const images = [];
  for (const pod of pods) for (const status of pod.status.containerStatuses) {
    const local = (await run('docker', ['image', 'inspect', status.image, '--format', '{{.Id}}'], { capture: true })).trim();
    const nodeImage = JSON.parse(await run('docker', ['exec', pod.spec.nodeName, 'crictl', 'inspecti', status.image], { capture: true }));
    assert.equal(nodeImage.status.id, local);
    images.push({ pod: pod.metadata.name, node: pod.spec.nodeName, image: status.image, reported: status.imageID, configID: local, reportedIdentityNote: 'kind import labels are not stable; configID is verified against the node image store' });
  }
  await writeFile(join(cluster.root, 'evidence.json'), JSON.stringify({ namespace: cluster.topology.namespace, images, claims, entry, result: 'two apps, native sessions, D1/R2/DO, replica/controller/gateway pod replacement passed' }, null, 2), { mode: 0o600 });
  console.log('PASS: Kubernetes scoped deployments and approval, two apps, native HTTPS sessions, D1/R2/DO across replica/controller/gateway pod replacement, retained PVC identities, image identity verification');
} finally { disconnect(); await account?.browser.close(); }
