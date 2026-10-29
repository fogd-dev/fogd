import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectHost as inspectHostWithTools } from '../src/doctor/host.mjs';
import { formatHostReport } from '../src/doctor/command.mjs';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';

const tool = async name => name === 'tar' ? 'bsdtar 3.5.3 - libarchive 3.5.3' : 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n';
const inspectHost = (family, run) => inspectHostWithTools(family, run, { run: tool, nodeVersion: '24.21.0' });
const qualified = runtimeFamilies().find(entry => entry.admission === 'qualified');
const host = { OSType: 'linux', Architecture: 'aarch64', Driver: 'overlay2', DriverStatus: [] };
function engine(entry = qualified, changes = {}, calls = []) {
  return async args => {
    calls.push(args);
    if (args[0] === 'info') return JSON.stringify({ ...host, ...changes });
    if (args[0] === 'compose') return '2.39.4';
    if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{ Id: args[2], Os: entry.os, Architecture: entry.architecture }]);
    assert.fail(`Unexpected Docker operation: ${args[0]}`);
  };
}
const statuses = report => Object.fromEntries(report.findings.map(item => [item.id, item.status]));

test('host diagnosis uses metadata only and never declares an installation ready', async () => {
  const calls = [], report = await inspectHost(qualified.id, engine(qualified, {}, calls));
  assert.equal(report.status, 'unverified');
  assert.equal(report.capacityReservation, 'none');
  assert.equal(report.readOnly, true);
  const checks = statuses(report);
  for (const id of ['client-node', 'client-tar', 'client-checksum', 'docker', 'admission', 'architecture', 'image-store', 'compose', 'runtime-image', 'storage-image']) assert.equal(checks[id], 'supported', id);
  for (const id of ['program-integrity', 'network', 'storage-space', 'tls', 'application']) assert.equal(checks[id], 'unverified', id);
  assert.deepEqual(calls, [
    ['info', '--format', '{{json .}}'], ['compose', 'version', '--short'],
    ['image', 'inspect', qualified.image], ['image', 'inspect', qualified.storageImage],
  ]);
  assert.match(formatHostReport(report), /Installation readiness is not established/);
});

test('candidate diagnosis reports closed ordinary admission even with matching images', async () => {
  const entry = runtimeFamilies().find(value => value.admission === 'candidate');
  const report = await inspectHost(entry.id, engine(entry));
  assert.equal(report.status, 'unsupported');
  assert.equal(statuses(report).admission, 'unsupported');
  assert.equal(statuses(report)['runtime-image'], 'supported');
  await assert.rejects(inspectHost('not-a-family', () => assert.fail('must not contact Docker')), /Unknown shipped/);
});

test('unsupported engine platform and image store are actionable without changing the host', async () => {
  for (const changes of [{ Architecture: 'x86_64' }, { OSType: 'windows' }]) {
    const report = await inspectHost(qualified.id, engine(qualified, changes));
    assert.equal(report.status, 'unsupported');
    assert.equal(statuses(report).architecture, 'unsupported');
  }
  for (const changes of [{ Driver: 'btrfs' }, { DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']] }]) {
    const report = await inspectHost(qualified.id, engine(qualified, changes));
    assert.equal(statuses(report)['image-store'], 'unsupported');
    assert.match(formatHostReport(report), /do not change a store holding existing data/);
  }
});

test('unavailable tools and unreadable daemon data stay unverified and do not leak diagnostics', async () => {
  const secret = 'private-engine-credential';
  const report = await inspectHost(qualified.id, async () => { throw new Error(secret); });
  for (const id of ['docker', 'compose', 'runtime-image', 'storage-image']) assert.equal(statuses(report)[id], 'unverified');
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!formatHostReport(report).includes(secret));
  for (const value of ['invalid-json', '{}', 'null', JSON.stringify({ ...host, DriverStatus: ['bad'] })]) {
    const run = engine();
    const result = await inspectHost(qualified.id, args => args[0] === 'info' ? value : run(args));
    assert.equal(statuses(result).docker, 'unverified');
    assert.equal(statuses(result).architecture, undefined);
  }
});

test('cached image presence requires the exact ID and platform, never inferred from a successful inspect', async () => {
  for (const image of [{ Id: qualified.image, Os: 'linux', Architecture: 'amd64' }, { Id: 'sha256:wrong', Os: 'linux', Architecture: 'arm64' }, {}]) {
    const run = engine();
    const report = await inspectHost(qualified.id, args => args[0] === 'image' && args[2] === qualified.image ? JSON.stringify([image]) : run(args));
    assert.equal(statuses(report)['runtime-image'], image.Architecture === 'amd64' ? 'unsupported' : 'unverified');
    assert.equal(statuses(report)['storage-image'], 'supported');
  }
});

test('unrecognized Compose versions do not count as supported', async () => {
  for (const [version, expected] of [['private-output', 'unverified'], ['1.29.2', 'unsupported'], ['v2.39.4', 'supported']]) {
    const run = engine();
    const report = await inspectHost(qualified.id, args => args[0] === 'compose' ? version : run(args));
    assert.equal(statuses(report).compose, expected);
    assert.ok(!JSON.stringify(report).includes('private-output'));
  }
});
