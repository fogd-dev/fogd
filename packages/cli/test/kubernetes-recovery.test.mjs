import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { settings } from './fixtures/kubernetes.mjs';
import { manifests } from '../src/kubernetes/render.mjs';
import { counts, claims } from '../src/kubernetes/recovery/contract.mjs';
import { validateShape } from '../src/kubernetes/recovery/shape.mjs';
import { restoredObjects, placementFor, verifyKubeBundle } from '../src/kubernetes/recovery/bundle.mjs';
import { checkWriters } from '../src/kubernetes/recovery/inventory.mjs';
import { helperPod } from '../src/kubernetes/recovery/pods.mjs';
import { kubeRestore } from '../src/kubernetes/recovery/restore.mjs';
import { fingerprint } from '../src/recovery/bundle.mjs';
import { validateClaims } from '../src/kubernetes/recovery/private-config.mjs';
import { execute } from '../src/recovery/execute.mjs';

function fixture() {
  return { topology: { ...settings, format: 'fogd-kubernetes-experimental-v1' }, desired: manifests(settings), secrets: { kind: 'List', items: ['fogd-private', 'fogd-tls'].map(name => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: settings.namespace }, data: name === 'fogd-tls' ? { 'keypair.json': Buffer.from(JSON.stringify({cert:'test-cert',key:'test-key'})).toString('base64') } : Object.fromEntries(['FOGD_ADMIN_USER','FOGD_ADMIN_PASSWORD','FOGD_GATEWAY_TOKEN','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','MINIO_ROOT_USER','MINIO_ROOT_PASSWORD'].map(k => [k, Buffer.from('fixture').toString('base64')])) })) }, manifest: { format: 'fogd-kube-stopped-v1', namespace: settings.namespace, images: { 'runtime:loaded': 'sha256:' + 'a'.repeat(64), 'minio:loaded': 'sha256:' + 'b'.repeat(64) }, pvc: claims.map(name => ({ name, node: name.endsWith('-1') ? 'source-worker2' : 'source-worker', spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'standard', resources: { requests: { storage: '2Gi' } } } })) } };
}
test('restore rewrites namespaces and creates zero writers without altering the snapshot', () => {
  const bundle = fixture(), restored = restoredObjects(bundle, 'restored');
  for (const resource of restored.stopped.items) {
    assert.equal(resource.metadata.namespace, 'restored');
    if (resource.kind === 'StatefulSet') assert.equal(resource.spec.replicas, 0);
  }
  assert.ok(bundle.desired.items.every(r => r.metadata.namespace === settings.namespace));
  assert.ok(restored.desired.items.filter(r => r.kind === 'StatefulSet').every(r => r.spec.replicas > 0));
  const nodes = ['target-worker', 'target-worker2', 'target-control-plane'].map(name => ({ metadata: { name } }));
  const placement = placementFor(bundle, nodes);
  assert.notEqual(placement['data-slot-1-0'], placement['data-slot-1-1']);
  bundle.manifest.pvc.find(c => c.name === 'data-slot-1-1').node = 'source-worker';
  assert.throws(() => placementFor(bundle, nodes), /co-locate/);
});
test('snapshot rejects foreign writers, alternate storage paths, external routing, and identity changes', () => {
  const sets = manifests(settings).items.filter(r => r.kind === 'StatefulSet');
  assert.throws(() => checkWriters({ pods: [{ metadata: { name: 'foreign' } }], controllers: [] }, sets), /Unexpected/);
  assert.throws(() => checkWriters({ pods: [], controllers: [{ kind: 'Job' }] }, sets), /Unexpected controller/);
  validateShape(manifests(settings), settings);
  const altered = manifests(settings);
  altered.items.find(r => r.kind === 'StatefulSet' && r.metadata.name === 'controller').spec.template.spec.containers[0].volumeMounts[0].mountPath = '/elsewhere';
  assert.throws(() => validateShape(altered, settings), /data mount/);
  const external = manifests(settings);
  external.items.find(r => r.kind === 'Service').spec.type = 'ExternalName';
  assert.throws(() => validateShape(external, settings), /external/);
});
test('helpers do not start application writers and archive mounts are read-only', () => {
  const helper = helperPod('restored', claims[0], 'worker-a', 'runtime:loaded', true);
  assert.equal(helper.spec.restartPolicy, 'Never');
  assert.equal(helper.spec.activeDeadlineSeconds, 900);
  assert.equal(helper.spec.volumes[0].persistentVolumeClaim.readOnly, true);
  assert.deepEqual(helper.spec.containers[0].command, ['sleep', '900']);
  assert.deepEqual(helper.spec.nodeSelector, { 'kubernetes.io/hostname': 'worker-a' });
  assert.equal(helper.spec.automountServiceAccountToken, false);
});
test('snapshot corruption fails before any Kubernetes target access', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-kube-recovery-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const data = fixture(), files = {};
  for (const [name, value] of Object.entries({ 'manifests.json': data.desired, 'secrets.json': data.secrets, 'topology.json': data.topology })) await writeFile(join(dir, name), JSON.stringify(value));
  for (const name of ['images.tar', 'started.json', 'stop.json', ...claims.map(c => c + '.tar')]) await writeFile(join(dir, name), name === 'started.json' ? JSON.stringify({namespace: settings.namespace, images:data.manifest.images}) : name === 'stop.json' ? JSON.stringify({complete:true, exits:Object.entries(counts).flatMap(([name,count])=>Array.from({length:count},(_,i)=>({name:`${name}-${i}`,uid:'fixture',containers:[{name:'process',outcome:'observed',exitCode:0,reason:'Completed'}]}))),uncertain:[]}) : 'archive');
  for (const name of ['manifests.json', 'secrets.json', 'topology.json', 'images.tar', 'started.json', 'stop.json', ...claims.map(c => c + '.tar')]) files[name] = await fingerprint(join(dir, name));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...data.manifest, files }));
  assert.equal((await verifyKubeBundle(dir)).manifest.namespace, settings.namespace);
  await writeFile(join(dir, 'data-minio-0.tar'), 'corrupt');
  await assert.rejects(kubeRestore(dir, 'fresh', join(dir, 'output'), '/does-not-exist', 'invalid'), /checksum mismatch/);
});
test('private command streams wait for full output and withhold failing diagnostics', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-stream-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'output');
  await execute(process.execPath, ['-e', 'process.stdout.end(Buffer.alloc(131072, 65))'], { output });
  assert.equal((await readFile(output)).length, 131072);
  await assert.rejects(execute(process.execPath, ['-e', 'console.error("private-value");process.exit(2)']), e => e.exitCode === 2 && !e.message.includes('private-value'));
});

test('restore cannot bind preexisting PVs through extra snapshot claim fields', () => {
  const bundle = fixture();
  validateClaims(bundle.manifest.pvc);
  bundle.manifest.pvc[0].spec.volumeName = 'foreign-pv';
  assert.throws(() => validateClaims(bundle.manifest.pvc), /claim fields/);
});

test('image archive metadata cannot retag unrelated images or mislabel configurations', async () => {
  const { imageTags } = await import('../src/kubernetes/recovery/image-archive.mjs');
  const id = 'a'.repeat(64), expected = { 'fogd:test': `sha256:${id}` };
  assert.throws(() => imageTags([], { '--output=foreign': `sha256:${id}` }), /image reference/);
  assert.deepEqual(imageTags([{ Config: `blobs/sha256/${id}`, RepoTags: ['fogd:test'] }], expected), { 'fogd:test': `blobs/sha256/${id}` });
  assert.throws(() => imageTags([{ Config: `${id}.json`, RepoTags: ['fogd:test', 'unrelated:latest'] }], expected), /unexpected tags/);
  assert.throws(() => imageTags([{ Config: 'b'.repeat(64) + '.json', RepoTags: ['fogd:test'] }], expected), /configuration identities/);
});
test('restore refuses pre-existing files before extracting any archive', async () => {
  const { restoreClaim } = await import('../src/kubernetes/recovery/pods.mjs');
  const calls = [];
  await assert.rejects(restoreClaim(async args => { calls.push(args); return '/data/old-state\n'; }, '/unused'), /empty claim/);
  await assert.rejects(restoreClaim(async () => ' \n', '/unused'), /empty claim/);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'find');
});
test('termination evidence distinguishes unknown, graceful, and killed writers', async () => {
  const { recordStopLine, uncertainStops } = await import('../src/kubernetes/recovery/stop-evidence.mjs');
  const expected = new Map([['minio-0', 'uid']]), records = new Map();
  recordStopLine('ADDED|minio-0|uid|running|minio:0:Completed;', expected, records);
  assert.deepEqual(uncertainStops([...records.values()]), ['minio-0']);
  recordStopLine('MODIFIED|minio-0|uid|terminating|minio:0:Completed;', expected, records);
  recordStopLine('DELETED|minio-0|uid|terminating|', expected, records);
  assert.deepEqual(uncertainStops([...records.values()]), []);
  recordStopLine('MODIFIED|minio-0|uid|terminating|minio:137:Error;', expected, records);
  assert.deepEqual(uncertainStops([...records.values()]), ['minio-0']);
  recordStopLine('DELETED|minio-0|other-uid|terminating|minio:0:Completed;', expected, records);
  assert.equal(records.get('minio-0').containers[0].exitCode, 137);
});

test('private command execution has a bounded timeout', async () => {
  await assert.rejects(execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }), /timed out/);
});

test('restore shape forbids privileged pods and initializers that can write durable claims', () => {
  const privileged = manifests(settings);
  privileged.items.find(r => r.kind === 'StatefulSet').spec.template.spec.containers[0].securityContext.privileged = true;
  assert.throws(() => validateShape(privileged, settings), /Privileged/);
  const writable = manifests(settings);
  writable.items.find(r => r.kind === 'StatefulSet' && r.metadata.name === 'controller').spec.template.spec.initContainers[0].volumeMounts = [{name:'data',mountPath:'/data'}];
  assert.throws(() => validateShape(writable, settings), /writable initialization/);
});
