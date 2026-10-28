import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { inspectApplicationConfig, inspectApplicationFile } from '../src/doctor/application.mjs';
import { formatReport } from '../src/doctor/report.mjs';

const checks = report => Object.fromEntries(report.findings.map(item => [item.id, item.status]));
const cron = { triggers: { crons: ['* * * * *'] } };

test('offline configuration diagnosis reports declarations without exposing variable or secret values', () => {
  const report = inspectApplicationConfig({ vars: { MESSAGE: 'private-variable-value' }, secrets: { required: ['API_KEY'] },
    d1_databases: [{ binding: 'DB' }], r2_buckets: [{ binding: 'FILES' }], durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
    assets: { directory: '../client' } }, 'demo');
  assert.deepEqual(report.declarations, { d1: 1, r2: 1, durableObjects: 1, queueProducers: 0, queueConsumers: 0, cronExpressions: 0, assets: true, requiredSecrets: 1 });
  assert.equal(report.status, 'unverified');
  assert.equal(report.capabilitySource, 'offline');
  assert.equal(checks(report)['config-declarations'], 'supported');
  assert.equal(checks(report)['target-capabilities'], 'unverified');
  assert.equal(checks(report)['resource-changes'], 'unverified');
  assert.equal(report.capacityReservation, 'none');
  assert.ok(!JSON.stringify(report).includes('private-variable-value'));
  assert.ok(!formatReport(report).includes('private-variable-value'));
  assert.match(formatReport(report), /d1=1/);
});

for (const [name, input] of [
  ['unsupported binding', { ai: { binding: 'PRIVATE' } }],
  ['unsupported flag', { compatibility_flags: ['private-flag-value'] }],
  ['duplicate binding', { vars: { DB: 'private-value' }, d1_databases: [{ binding: 'DB' }] }],
  ['multiple databases', { d1_databases: [{ binding: 'FIRST' }, { binding: 'SECOND' }] }],
  ['cross-script object', { durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room', script_name: 'private-script' }] } }],
  ['nonobject root', []],
]) test(`configuration diagnosis refuses ${name} through the shared validator`, () => {
  const report = inspectApplicationConfig(input, 'demo');
  assert.equal(report.status, 'unsupported');
  assert.equal(checks(report)['config-declarations'], 'unsupported');
  assert.equal(report.declarations, null);
  assert.ok(!JSON.stringify(report).includes('private-'));
});

test('offline cron declaration validation cannot claim target admission', () => {
  const report = inspectApplicationConfig(cron, 'demo');
  assert.equal(report.declarations.cronExpressions, 1);
  assert.equal(checks(report)['config-declarations'], 'supported');
  assert.equal(checks(report)['cron-admission'], 'unverified');
  assert.equal(report.status, 'unverified');
});

for (const [allowed, status] of [[false, 'unsupported'], [true, 'unverified']]) test(`actual controller cron admission ${allowed} controls the configuration result`, () => {
  const report = inspectApplicationConfig(cron, 'demo', { cronApps: allowed }, true);
  assert.equal(report.status, status);
  assert.equal(report.capabilitySource, 'controller');
  assert.equal(checks(report)['target-capabilities'], 'supported');
});

test('failed capability observation stays unverified even for valid cron declarations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fogd-app-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'config.json'), bytes = JSON.stringify(cron);
  await writeFile(file, bytes);
  const report = await inspectApplicationFile(file, 'demo', async app => { assert.equal(app, 'demo'); throw new Error('private-transport-diagnostic'); });
  assert.equal(report.capabilitySource, 'unavailable');
  assert.equal(checks(report)['cron-admission'], 'unverified');
  assert.equal(report.configSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(!JSON.stringify(report).includes('private-'));
});

test('unreadable and linked configuration is not evaluated and does not contact a controller', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fogd-app-doctor-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'invalid'), 'private-invalid-json');
  await writeFile(join(root, 'large'), ' '.repeat(1024 * 1024 + 1));
  await symlink(join(root, 'invalid'), join(root, 'linked'));
  for (const name of ['absent', 'invalid', 'large', 'linked']) {
    const report = await inspectApplicationFile(join(root, name), 'demo', () => assert.fail('must not query capabilities'));
    assert.equal(report.status, 'unverified');
    assert.equal(checks(report)['config-file'], 'unverified');
    assert.ok(!JSON.stringify(report).includes('private-invalid-json'));
  }
});
