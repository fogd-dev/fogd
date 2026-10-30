import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import { createPreviewExecutionAuthority, signPreviewExecution, verifyPreviewExecution, previewExecutionSha256 } from '../src/preview/execution-authority.mjs';
import { issuePreviewExecution, authorizePreviewExecution } from '../src/preview/execution.mjs';
import { previewNetworks, assertPreviewNetwork, previewDns } from '../src/preview/networks.mjs';

function fixture() {
  const runtime = { family: 'preview-test-v10', catalogEntrySha256: '1'.repeat(64) };
  const preparation = { schema: 1, kind: 'fogd-preview-preparation', id: '00000000-0000-4000-8000-000000000001', status: 'prepared', preparedAt: new Date(Date.now() - 1000).toISOString(),
    source: { controller: 'https://source.test', app: 'demo', submission: '00000000-0000-4000-8000-000000000002', digest: '2'.repeat(64), reviewSha256: '3'.repeat(64) }, runtime,
    policy: { lifetimeSeconds: 60, storage: 'fresh-empty-only', secrets: 'preview-only', requiredSecrets: [], background: 'disabled', network: 'no-external-egress', access: 'owner-authenticated', expiry: 'deny-requests-and-stop-writers', dataPromotion: 'none' }, executionAuthorized: false, capacityReserved: false, scope: 'Verified fixture preparation only' };
  const target = { project: 'preview-fresh', installation: '4'.repeat(64), configSha256: '5'.repeat(64), runtime,
    origin: 'https://demo.preview.test', networks: { control: '10.241.1.0/24', 'fleet-1': '10.241.2.0/24', 'fleet-2': '10.241.3.0/24', frontend: '10.241.4.0/24' } };
  const release = { app: 'demo', digest: preparation.source.digest, requiredSecrets: [], resources: { script: 'demo', durable: { bindings: [] }, d1: [], r2: [] } }, authority = createPreviewExecutionAuthority();
  const expectedPreparationSha256 = hash(jsonBytes(preparation));
  const envelope = issuePreviewExecution(preparation, { expectedPreparationSha256, release, target, privateKey: authority.privateKey });
  const expected = { publicKey: authority.publicKey, expectedGrantSha256: previewExecutionSha256(envelope), preparationSha256: expectedPreparationSha256, target };
  return { preparation, release, target, authority, envelope, expected, expectedPreparationSha256 };
}
const refused = { code: 'PREVIEW_EXECUTION_REFUSED' };

test('owner execution decision binds exact preparation, release, target and launch lifetime', () => {
  const f = fixture(), before = structuredClone(f.preparation), grant = authorizePreviewExecution(f.envelope, f.expected);
  assert.equal(grant.purpose, 'preview-execution'); assert.equal(grant.productionActivation, false);
  assert.deepEqual(grant.source, f.preparation.source); assert.deepEqual(grant.target, f.target);
  assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt), 60000);
  assert.equal(grant.actor.uid, process.getuid()); assert.equal(grant.actor.kind, 'local-owner');
  assert.deepEqual(f.preparation, before); assert.equal(f.preparation.executionAuthorized, false);
  assert.ok(!JSON.stringify(f.envelope).includes('PRIVATE KEY')); assert.ok(!Object.hasOwn(f.envelope, 'publicKey'));
});

for (const change of [
  g => { g.source.digest = '6'.repeat(64); }, g => { g.target.origin = 'https://other.test'; },
  g => { g.target.configSha256 = '6'.repeat(64); }, g => { g.expiresAt = new Date(Date.parse(g.expiresAt) + 1000).toISOString(); },
  g => { g.productionActivation = true; }, g => { g.purpose = 'production-activation'; },
]) test(`altered execution grant cannot retain authority: ${change.toString()}`, () => {
  const f = fixture(), altered = structuredClone(f.envelope); change(altered.grant);
  assert.throws(() => verifyPreviewExecution(altered, f.authority.publicKey), refused);
});

test('a self-signed message cannot replace the independently supplied execution authority', () => {
  const f = fixture(), attacker = createPreviewExecutionAuthority();
  const forged = signPreviewExecution(f.envelope.grant, attacker.privateKey);
  assert.throws(() => verifyPreviewExecution(forged, f.authority.publicKey), refused);
  assert.throws(() => verifyPreviewExecution({ ...forged, publicKey: attacker.publicKey }, attacker.publicKey), refused);
});

for (const field of ['expectedGrantSha256', 'preparationSha256']) test(`a valid signature cannot override independently selected ${field}`, () => {
  const f = fixture(); assert.throws(() => authorizePreviewExecution(f.envelope, { ...f.expected, [field]: '9'.repeat(64) }), refused);
});

test('a signed grant for another target cannot be used on the current installation', () => {
  const f = fixture(), target = { ...f.target, installation: '9'.repeat(64) };
  assert.throws(() => authorizePreviewExecution(f.envelope, { ...f.expected, target }), refused);
});

test('expired signed metadata stays inspectable but cannot execute or renew itself', t => {
  const f = fixture(); t.mock.method(Date, 'now', () => Date.parse(f.envelope.grant.expiresAt));
  assert.deepEqual(verifyPreviewExecution(f.envelope, f.authority.publicKey), f.envelope.grant);
  assert.throws(() => authorizePreviewExecution(f.envelope, f.expected), refused);
  assert.throws(() => authorizePreviewExecution(f.envelope, f.expected), refused);
});

test('a grant is refused before its issue time when the trusted clock is behind', t => {
  const f = fixture(); t.mock.method(Date, 'now', () => Date.parse(f.envelope.grant.issuedAt) - 1);
  assert.throws(() => authorizePreviewExecution(f.envelope, f.expected), refused);
});

test('untrusted preparation edits or a runtime substitution cannot become an owner grant', () => {
  const f = fixture(); f.preparation.executionAuthorized = true;
  assert.throws(() => issuePreviewExecution(f.preparation, { expectedPreparationSha256: f.expectedPreparationSha256, release: f.release, target: f.target, privateKey: f.authority.privateKey }), refused);
  const next = fixture(), target = { ...next.target, runtime: { ...next.target.runtime, family: 'another-runtime' } };
  assert.throws(() => issuePreviewExecution(next.preparation, { expectedPreparationSha256: next.expectedPreparationSha256, release: next.release, target, privateKey: next.authority.privateKey }), refused);
});

for (const resources of [{ queues: {} }, { crons: ['* * * * *'] }, { durable: { bindings: [{ class_name: 'AlarmCapable' }] } }]) test(`the first execution profile refuses background-capable declarations: ${Object.keys(resources)[0]}`, () => {
  const f = fixture(), release = { ...f.release, resources: { ...f.release.resources, ...resources } };
  assert.throws(() => issuePreviewExecution(f.preparation, { expectedPreparationSha256: f.expectedPreparationSha256, release, target: f.target, privateKey: f.authority.privateKey }), refused);
});

test('private preview networks remove the bridge gateway while only the frontend uses NAT', () => {
  const f = fixture(), networks = previewNetworks(f.target.project, f.target.networks);
  for (const [role, network] of Object.entries(networks)) {
    assert.equal(network.internal, role !== 'frontend');
    assert.equal(network.driver_opts['com.docker.network.bridge.gateway_mode_ipv4'], role === 'frontend' ? 'nat' : 'isolated');
  }
  assert.deepEqual(previewDns, { dns: ['127.0.0.1'], dns_opt: ['timeout:1', 'attempts:1'] });
  const network = networks.control, observed = { Name: network.name, Driver: 'bridge', Scope: 'local', Internal: true, EnableIPv6: false, EnableIPv4: true, Ingress: false, ConfigOnly: false,
    Options: network.driver_opts, Labels: network.labels, IPAM: { Driver: 'default', Config: [{ Subnet: f.target.networks.control }], Options: {} }, ConfigFrom: { Network: '' } };
  assert.doesNotThrow(() => assertPreviewNetwork(network, observed));
  assert.throws(() => assertPreviewNetwork(network, { ...observed, IPAM: { ...observed.IPAM, Config: [{ Subnet: f.target.networks.control, Gateway: '10.241.1.1' }] } }), refused);
  assert.throws(() => assertPreviewNetwork(network, { ...observed, Options: {} }), refused);
});

test('a viewer access key cannot sign or verify an execution decision', () => {
  const f = fixture(), viewerKey = 'a'.repeat(64);
  assert.throws(() => signPreviewExecution(f.envelope.grant, viewerKey), refused);
  assert.throws(() => verifyPreviewExecution(f.envelope, viewerKey), refused);
});

test('execution refuses a resource script identity that differs from the prepared application', () => {
  const f = fixture(), release = { ...f.release, resources: { ...f.release.resources, script: 'another-app' } };
  assert.throws(() => issuePreviewExecution(f.preparation, { expectedPreparationSha256: f.expectedPreparationSha256, release, target: f.target, privateKey: f.authority.privateKey }), refused);
});
