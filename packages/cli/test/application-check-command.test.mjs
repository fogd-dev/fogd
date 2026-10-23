import test from 'node:test';
import assert from 'node:assert/strict';
import { rootCertificates } from 'node:tls';
import { readFile, writeFile } from 'node:fs/promises';
import { observationFixture } from './fixtures/observation-cli.mjs';

const helper = row => row.args[0] === 'run' && row.args.some(value => value.startsWith('fogd.observer.id='));
async function fixture(t) {
  const f = await observationFixture(t);
  return { ...f, check: (app = 'sample', extra = {}) => f.invoke([app, '--installation', f.project, '--path', '/health'], { ...extra, FOGD_CHECK_TEST: '1' }) };
}

test('owner check requests one selected gateway with no private inputs or response contents', async t => {
  const f = await fixture(t), result = await f.check(), report = JSON.parse(result.stdout);
  assert.deepEqual(report.ingressResponse, { state: 'observed', httpStatus: 503, headersMs: 7, reason: null });
  assert.equal(report.applicationExecution, 'not-proven'); assert.equal(report.applicationHealth, 'not-observed');
  assert.equal(report.controllerRecord, 'matched-at-boundaries'); assert.equal(report.gatewayProcess, 'matched-at-boundaries');
  assert.doesNotMatch(result.stdout, /private-|body|secret|credentials/);
  const workers = (await f.calls()).filter(helper); assert.equal(workers.length, 1);
  const { input, args } = workers[0];
  assert.deepEqual(JSON.parse(input), { address: '172.20.0.10', host: 'sample.localhost', tls: false, path: '/health', ca: null });
  assert.equal(args[args.indexOf('--network') + 1], f.plan.config.networks.control.name);
  const launch = args.slice(0, args.indexOf(f.plan.config.services.controller.image));
  for (const forbidden of ['--mount', '--volume', '-v', '--env', '-e', '--privileged']) assert.equal(launch.includes(forbidden), false);
  assert.ok(launch.includes('--read-only')); assert.equal(launch[launch.indexOf('--pull') + 1], 'never');
  assert.equal(launch[launch.indexOf('--cap-drop') + 1], 'ALL');
});

test('changed release metadata withholds the sampled status rather than attributing it to a release', async t => {
  const f = await fixture(t), result = await f.check('sample', { FOGD_OBSERVE_STATE_CHANGE: '1' }), report = JSON.parse(result.stdout);
  assert.equal(report.controllerRecord, 'changed');
  assert.deepEqual(report.ingressResponse, { state: 'uncertain', httpStatus: null, headersMs: null, reason: 'controller-record-unconfirmed' });
});

test('an unknown application refuses without sending an HTTP helper', async t => {
  const f = await fixture(t);
  await assert.rejects(f.check('other'), error => error.code === 1 && /No recorded application/.test(error.stderr) && error.stdout === '');
  assert.equal((await f.calls()).some(helper), false);
});

test('a withheld application sends no HTTP helper', async t => {
  const f = await fixture(t);
  const data = JSON.parse(await readFile(f.data, 'utf8')); data.state.apps.sample.route = 'paused'; await writeFile(f.data, JSON.stringify(data));
  const paused = JSON.parse((await f.check()).stdout);
  assert.equal(paused.ingressResponse.state, 'not-requested'); assert.equal((await f.calls()).some(helper), false);
});

for (const path of ['https://other.example', '//other.example', '/__void/ready', '/%5f%5fvoid/ready', '/.well-known/celld/health', '/health?token=private', '/health#private']) {
  test(`unsafe application check path refuses before Docker: ${path}`, async t => {
    const f = await fixture(t);
    await assert.rejects(f.invoke(['sample', '--installation', f.project, '--path', path], { FOGD_CHECK_TEST: '1' }), error => error.code === 1);
    assert.deepEqual(await f.calls(), []);
  });
}

test('a foreign gateway network makes the check uncertain without sending a request', async t => {
  const f = await fixture(t), report = JSON.parse((await f.check('sample', { FOGD_OBSERVE_FOREIGN_NETWORK: 'foreign' })).stdout);
  assert.equal(report.ingressResponse.state, 'not-requested'); assert.equal(report.ingressResponse.reason, 'gateway-scope-unconfirmed');
  assert.equal((await f.calls()).some(helper), false);
});

test('unconfirmed helper cleanup fails the command instead of producing an observed status', async t => {
  const f = await fixture(t);
  await assert.rejects(f.check('sample', { FOGD_OBSERVE_HELPER_FAIL: '1', FOGD_OBSERVE_CLEANUP_FAIL: '1' }), error => error.code === 1 && /cleanup is unconfirmed/.test(error.stderr) && error.stdout === '');
});

for (const [name, gateway] of [
  ['another image', { Image: 'sha256:' + 'f'.repeat(64) }],
  ['another entry point', { Config: { Cmd: ['node', 'private-other-app.mjs'] } }],
  ['an unavailable process', { State: { Running: false, Paused: false, Restarting: false, StartedAt: '2026-10-23T00:00:00Z' } }],
]) test(`gateway with ${name} refuses before sending an application request`, async t => {
  const f = await fixture(t), data = JSON.parse(await readFile(f.data, 'utf8'));
  await writeFile(f.data, JSON.stringify({ ...data, gateway }));
  const result = await f.check(), report = JSON.parse(result.stdout);
  assert.equal(report.ingressResponse.state, 'not-requested'); assert.equal((await f.calls()).some(helper), false);
  assert.doesNotMatch(result.stdout, /private-other-app/);
});

for (const prefix of ['', rootCertificates[0] + '\n']) test('a CA file containing a private key refuses before Docker without printing its contents', async t => {
  const f = await fixture(t), path = f.root + '/not-a-ca.pem';
  await writeFile(path, prefix + '-----BEGIN PRIVATE KEY-----\nprivate-test-value\n-----END PRIVATE KEY-----');
  await assert.rejects(f.invoke(['sample', '--installation', f.project, '--path', '/health', '--ca', path], { FOGD_CHECK_TEST: '1' }),
    error => error.code === 1 && /certificates only/.test(error.stderr) && !error.stderr.includes('private-test-value') && error.stdout === '');
  assert.deepEqual(await f.calls(), []);
});

test('an oversized CA file refuses before Docker', async t => {
  const f = await fixture(t), path = f.root + '/oversized-ca.pem';
  await writeFile(path, 'x'.repeat(65537));
  await assert.rejects(f.invoke(['sample', '--installation', f.project, '--path', '/health', '--ca', path], { FOGD_CHECK_TEST: '1' }),
    error => error.code === 1 && /bounded regular PEM file/.test(error.stderr) && error.stdout === '');
  assert.deepEqual(await f.calls(), []);
});
