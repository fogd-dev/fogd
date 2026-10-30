import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, stat, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';
import { readDurableRetirementPlan } from '../src/runtime/durable-retirement-plan.mjs';
import { retirementReview, assertRetirementReview } from '../src/recovery/retirement-review.mjs';
import { sourceBundle } from './fixtures/durable-recovery.mjs';
import { runtimeCli } from './fixtures/runtime-cli.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const source = await sourceBundle(t, ['alpha', 'beta']), p = source.policy;
  const entry = { ...runtimeFamilies()[0], schema: 2, routing: 'durable', id: p.family, admission: 'qualified',
    image: p.image, storageImage: p.storageImage, binarySha256: p.binarySha256, supervisorSha256: p.supervisorSha256 };
  entry.sourceFiles['packages/platform/src/import-retired-routes.mjs'] = 'a'.repeat(64);
  const selection = { expectedIdentity: runtimePolicyIdentity(p) }, retirement = { app: 'alpha', digest: source.request.digest };
  const plan = () => readDurableRetirementPlan(source.dir, 'after-retirement', selection, retirement, { choose: () => entry });
  return { source, entry, selection, retirement, plan };
}

test('retirement review reports exact snapshot identity, downtime, retained bytes and conditional capacity without private data', async t => {
  const f = await fixture(t), plan = await f.plan(), result = retirementReview(plan);
  const bytes = await Promise.all(Object.keys(f.source.manifest.files).map(name => stat(join(f.source.dir, name))));
  assert.equal(result.retention.archiveMemberBytes, bytes.reduce((sum, file) => sum + file.size, 0));
  assert.deepEqual(result.application, { name: 'alpha', deployment: f.source.request.id, digest: f.source.request.digest, snapshotRouting: 'active', fleet: 'slot-1' });
  assert.equal(result.source.project, f.source.config.name); assert.equal(result.source.identitySha256, f.selection.expectedIdentity);
  assert.equal(result.target.project, 'after-retirement');
  assert.deepEqual(result.capacity, { plannedReleasedFleetSlots: 1, availability: 'after-verified-target-completion', liveAvailableSlots: null, isReservation: false });
  assert.equal(result.effects.downtime, 'whole-installation'); assert.equal(result.effects.retiredName, 'permanent');
  assert.equal(result.effects.survivingHTTP, 'withheld'); assert.equal(result.retention.diskBytesReclaimed, 0);
  assert.equal(result.retention.operatorPins, 2); assert.equal(result.recovery.independentAppRestore, 'unsupported');
  assert.equal(result.checks.liveSource, 'not-observed'); assert.equal(result.checks.cachedImages, 'not-observed');
  const text = JSON.stringify(result);
  for (const value of ['private-user', 'private-password', 'private-gateway', 'source-private-value', f.source.root]) assert.ok(!text.includes(value));
  assert.match(result.plan, /^[a-f0-9]{64}$/);
});

test('new generation IDs do not change a review or reserve its future resources', async t => {
  const f = await fixture(t), first = await f.plan(), second = await f.plan();
  assert.notEqual(first.retirement.evidence.id, second.retirement.evidence.id);
  assert.deepEqual(retirementReview(first), retirementReview(second));
  assertRetirementReview(second, retirementReview(first).plan);
});

test('review binding changes with target, network placement, snapshot, artifact, source identity or background-loss consent', async t => {
  const f = await fixture(t), original = await f.plan(), expected = retirementReview(original).plan;
  const changes = [plan => { plan.target.config.name = 'other-target'; },
    plan => { plan.target.policy.networks = { control: '10.90.0.0/24', 'slot-1': '10.90.1.0/24', 'slot-2': '10.90.2.0/24' }; },
    plan => { plan.snapshot = '0'.repeat(64); }, plan => { plan.retirement.digest = '1'.repeat(64); },
    plan => { plan.source.policy.bucket = 'other-bucket'; }, plan => { plan.retirement.stopQueuedWork = true; },
    plan => { plan.retirement.stopScheduledWork = true; }];
  for (const change of changes) {
    const changed = structuredClone(original); change(changed);
    assert.throws(() => assertRetirementReview(changed, expected), /review changed/);
  }
  assert.throws(() => assertRetirementReview(original, 'invalid'), /review changed/);
});

test('the verified plan reader rejects an old review when snapshot bytes change', async t => {
  const f = await fixture(t), expected = retirementReview(await f.plan()).plan;
  await writeFile(join(f.source.dir, 'manifest.json'), JSON.stringify(f.source.manifest) + '\n');
  await assert.rejects(readDurableRetirementPlan(f.source.dir, 'after-retirement', f.selection,
    { ...f.retirement, expectedPlan: expected }, { choose: () => f.entry }), { code: 'DURABLE_RETIREMENT_PLAN_REFUSED' });
});

async function cliFixture(t) {
  const f = await fixture(t), program = await runtimeCli(f.source.root, 'qualified');
  await writeFile(program.catalog, JSON.stringify([f.entry]));
  const bin = join(f.source.root, 'bin'), log = join(f.source.root, 'docker-called'); await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nprintf called >> "$FOGD_TEST_DOCKER_LOG"\nexit 91\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FOGD_TEST_DOCKER_LOG: log,
    FOGD_HOME: join(f.source.root, 'unused-home'), DOCKER_HOST: 'unix:///missing-retirement-plan-docker.sock' };
  const args = [f.source.dir, '--app', 'alpha', '--digest', f.source.request.digest, '--project', 'after-retirement',
    '--runtime', f.entry.id, '--expected-identity', f.selection.expectedIdentity];
  return { ...f, program, log, env, args, invoke: extra => exec(process.execPath, [program.cli, 'retire', ...extra], { cwd: f.source.root, env, timeout: 15000 }) };
}

test('real CLI planning reads the verified snapshot without Docker, output allocation or source modification', async t => {
  const f = await cliFixture(t), before = await readFile(join(f.source.dir, 'manifest.json'));
  const first = JSON.parse((await f.invoke(['plan', ...f.args])).stdout), second = JSON.parse((await f.invoke(['plan', ...f.args])).stdout);
  assert.equal(first.plan, second.plan); assert.equal(first.source.runtime, f.entry.id);
  assert.equal(first.application.digest, f.source.request.digest); assert.equal(first.effects.targetServices, 'stopped');
  await assert.rejects(lstat(f.log), { code: 'ENOENT' });
  await assert.rejects(lstat(f.env.FOGD_HOME), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(f.source.dir, 'manifest.json')), before);
});

test('real CLI stale reviewed execution refuses before Docker or target allocation', async t => {
  const f = await cliFixture(t), output = join(f.source.root, 'not-created');
  await assert.rejects(f.invoke([...f.args, '--output', output, '--expected-plan', '0'.repeat(64)]), error => {
    assert.match(error.stderr, /Durable restore is unconfirmed/); return true;
  });
  await assert.rejects(lstat(f.log), { code: 'ENOENT' }); await assert.rejects(lstat(output), { code: 'ENOENT' });
});

test('planning rejects execution-only arguments before Docker or allocation', async t => {
  const f = await cliFixture(t);
  await assert.rejects(f.invoke(['plan', ...f.args, '--output', join(f.source.root, 'not-created')]), error => {
    assert.match(error.stderr, /Usage: fogd retire/); return true;
  });
  await assert.rejects(lstat(f.log), { code: 'ENOENT' });
});

for (const name of ['manifest.json', 'compose.json']) test(`plan refuses a ${name} named pipe without waiting for a writer`, async t => {
  const f = await cliFixture(t), path = join(f.source.dir, name);
  await unlink(path); execFileSync('mkfifo', [path]);
  await assert.rejects(f.invoke(['plan', ...f.args]), error => {
    assert.match(error.stderr, /Durable retirement requires/); return true;
  });
  await assert.rejects(lstat(f.log), { code: 'ENOENT' });
});

test('reviewed execution refuses a manifest named pipe before reading or contacting Docker', async t => {
  const f = await cliFixture(t), path = join(f.source.dir, 'manifest.json');
  await unlink(path); execFileSync('mkfifo', [path]);
  await assert.rejects(f.invoke([...f.args, '--output', join(f.source.root, 'not-created'), '--expected-plan', '0'.repeat(64)]), error => {
    assert.match(error.stderr, /regular snapshot manifest/); return true;
  });
  await assert.rejects(lstat(f.log), { code: 'ENOENT' });
});
