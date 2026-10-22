import test from 'node:test';
import assert from 'node:assert/strict';
import { kubeSettings } from '../src/kubernetes/config.mjs';
import { manifests, secrets } from '../src/kubernetes/render.mjs';
import { memoryQuantity } from '../src/kubernetes/workloads.mjs';
import { requireDocker } from '../src/local.mjs';

import { settings } from './fixtures/kubernetes.mjs';

test('Kubernetes output keeps secrets separate and limits public access to explicit Services', () => {
  const output = manifests(settings), serialized = JSON.stringify(output);
  for (const value of ['private-admin', 'private-gateway', 'private-bucket', 'test-private-key']) assert.ok(!serialized.includes(value));
  assert.ok(output.items.every(r => r.kind !== 'Namespace'));
  const privateOutput = secrets(settings);
  assert.equal(JSON.parse(privateOutput.items.find(r => r.metadata.name === 'fogd-tls').stringData['keypair.json']).key, 'test-private-key');
  for (const item of output.items.filter(r => r.kind === 'Service')) assert.ok(!item.spec.type || item.spec.type === 'ClusterIP');
  for (const item of output.items.filter(r => r.kind === 'StatefulSet')) {
    assert.equal(item.spec.template.spec.automountServiceAccountToken, false);
    assert.equal(item.spec.updateStrategy.type, 'OnDelete');
    assert.equal(item.spec.persistentVolumeClaimRetentionPolicy.whenDeleted, 'Retain');
  }
});
test('replica DNS, ordinals, and disks retain one stable ownership relationship', () => {
  const output = manifests(settings).items;
  for (const slot of settings.slots) {
    assert.equal(output.find(r => r.kind === 'Service' && r.metadata.name === slot.id).spec.publishNotReadyAddresses, true);
    const fleet = output.find(r => r.kind === 'StatefulSet' && r.metadata.name === slot.id);
    const pod = fleet.spec.template.spec;
    assert.equal(fleet.spec.replicas, 2);
    assert.equal(pod.containers[0].env.find(e => e.name === 'CELLD_NODE').valueFrom.fieldRef.fieldPath, 'metadata.name');
    assert.ok(pod.containers[0].args.includes('$(CELLD_NODE):8081'));
    assert.equal(pod.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].topologyKey, 'kubernetes.io/hostname');
    assert.equal(pod.containers[0].livenessProbe, undefined);
    assert.ok(fleet.spec.volumeClaimTemplates.some(c => c.metadata.name === 'data'));
  }
});
test('Kubernetes cannot silently fall back to Docker backup or plaintext settings', () => {
  assert.throws(() => requireDocker({ FOGD_TOPOLOGY: 'kubernetes' }), /PVC recovery/);
  assert.doesNotThrow(() => requireDocker({}));
  assert.throws(() => kubeSettings({}, {}), /shared profile/);
  assert.throws(() => kubeSettings({ FOGD_PROFILE: 'shared' }, {}), /TLS/);
  assert.throws(() => kubeSettings({ FOGD_PROFILE: 'shared', FOGD_TLS: '1', FOGD_KUBE_NAMESPACE: '../bad' }, {}), /DNS label/);
});

test('Docker memory units and configured admission limits survive Kubernetes rendering', () => {
  assert.equal(memoryQuantity('512m'), '512Mi');
  assert.equal(memoryQuantity('2G'), '2Gi');
  const configured = structuredClone(settings);
  configured.env.FOGD_MAX_ARTIFACT_BYTES = '1024';
  configured.env.FOGD_CELLD_MEMORY = '512m';
  const output = manifests(configured).items;
  const controller = output.find(r => r.kind === 'StatefulSet' && r.metadata.name === 'controller');
  assert.equal(controller.spec.template.spec.containers[0].env.find(e => e.name === 'FOGD_MAX_ARTIFACT_BYTES').value, '1024');
  const fleet = output.find(r => r.kind === 'StatefulSet' && r.metadata.name === 'slot-1');
  assert.equal(fleet.spec.template.spec.containers[0].resources.limits.memory, '512Mi');
  for (const name of ['slot-1-0', 'slot-1-1']) {
    const service = output.find(r => r.kind === 'Service' && r.metadata.name === name);
    assert.equal(service.spec.selector['statefulset.kubernetes.io/pod-name'], name);
    assert.equal(service.spec.clusterIP, undefined);
  }
});

test('Kubernetes rendering never enables the Docker-only queue admission opt-in', () => {
  const selected = structuredClone(settings); selected.env.FOGD_QUEUE_APPS = '1';
  const controller = manifests(selected).items.find(r => r.kind === 'StatefulSet' && r.metadata.name === 'controller');
  assert.equal(controller.spec.template.spec.containers[0].env.some(e => e.name === 'FOGD_QUEUE_APPS' && e.value === '1'), false);
});

test('Kubernetes settings refuse the development storage password before rendering private state', () => {
  const env = { FOGD_PROFILE: 'shared', FOGD_TLS: '1', FOGD_KUBE_NAMESPACE: 'fogd-test', FOGD_ADMIN_USER: 'operator',
    FOGD_ADMIN_PASSWORD: 'private-admin', FOGD_GATEWAY_TOKEN: 'private-gateway', FOGD_BUCKET_USER: 'fogd-local', FOGD_BUCKET_PASSWORD: 'fogd-local-development-only' };
  assert.throws(() => kubeSettings(env, {}), /Shared storage requires/);
});
