import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { selectedHostTrial } from './selected-trial.mjs';
import { copyFixture } from './project-copy.mjs';
import { httpsClient, scopedClient, waitFor } from './https.mjs';
import { scanPublicSurfaces } from './privacy.mjs';
import { stopSelectedHost } from './shutdown.mjs';
import { composeArgs, json, docker } from '../../../packages/cli/src/recovery/docker.mjs';
import { servingSession, markServing } from '../../capacity/serving-session.mjs';
import { paddedUpload } from '../../capacity/padded-upload.mjs';
import { servingReport, interferenceReads } from '../../capacity/serving-observer.mjs';

await selectedHostTrial(process.argv[2], 'Paired paced serving observations on a fresh frozen local two-fleet Docker family: gateway versus one direct replica, maximum uploads, peer activation, controller outage and recovery. Not a density or production availability claim.', async context => {
  const { source: host, evidence } = context;
  const fixture = await fixtures(host), observer = `${host.project}-observer`;
  evidence.hardware = await hardware(host); evidence.phases = {};
  await startObserver(host, observer, fixture.fleet);
  const settings = { targets: { gateway: 'workerd', direct: fixture.fleet.nodes[0].host }, ca: await readFile(host.env.NODE_EXTRA_CA_CERTS, 'utf8'), bodySha256: fixture.bodySha256, concurrency: 2, maxDurationMs: 300000 };
  for (const [name, durationMs, action] of phases(host, fixture)) {
    context.phase = name;
    evidence.phases[name] = await window(host, observer, name, { ...settings, durationMs }, action);
    evidence.phases[name].controller = await controllerMetrics(host);
    const state = (await fixture.request('/v1/admin')).json();
    assert.equal(state.apps.baseline.active, fixture.baseline.id); assert.equal(state.deployments[fixture.baseline.id].digest, fixture.baseline.digest);
    evidence.phases[name].baselineApprovalUnchanged = true;
  }
  evidence.privacy = await scanPublicSurfaces(host, (path, options = {}) => fixture.request(path, { ...options, maxResponseBytes: path.endsWith('/artifact') ? 64 * 1024 ** 2 : 4 * 1024 ** 2 }), fixture.submissions, fixture.tokens.builder, [], evidence);
  context.phase = 'clean-shutdown'; evidence.shutdown = await stopSelectedHost(host); host.closed = true;
  return fixture;
}, 'public');

async function fixtures(host) {
  const request = await httpsClient(host);
  await waitFor('serving owner API', async () => (await request('/v1/admin')).status === 200);
  const token = (await host.json(['admin', 'issue-token', 'serving-builder', 'baseline,peer'])).token;
  const submissions = [];
  for (const app of ['baseline', 'peer']) {
    const project = await copyFixture(host, 'guestbook', app);
    await appendFile(join(project, 'db/migrations/20261016160656_complete_ser_duncan.sql'), `\nINSERT INTO messages (id, text, created_at) VALUES (1, '${app} serving fixture', '2026-10-22 00:00:00');\n`);
    const submitted = await host.json(['deploy', '--name', app], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token }, cwd: project });
    assert.equal(submitted.status, 'pending'); await host.command(['admin', 'approve', submitted.id, submitted.digest]); submissions.push(submitted);
  }
  const state = (await request('/v1/admin')).json(), fleet = host.policy.fleets.find(value => value.id === state.apps.baseline.slot);
  assert.ok(fleet); assert.notEqual(state.apps.baseline.slot, state.apps.peer.slot);
  const response = await request('/api/messages', { app: 'baseline' }); assert.equal(response.status, 200); assert.deepEqual(response.json(), [{ id: 1, text: 'baseline serving fixture', createdAt: '2026-10-22 00:00:00' }]);
  const artifact = await request(`/v1/deployments/${submissions[1].id}/artifact`); assert.equal(artifact.status, 200);
  const upload = paddedUpload(artifact.json());
  assert.ok(state.quota.maxArtifactBytes - state.quota.retainedArtifactBytes >= upload.artifactBytes * 2);
  return { request, scoped: await scopedClient(host, token), tokens: { builder: token }, secret: token, submissions, fleet, upload, initialRetainedBytes: state.quota.retainedArtifactBytes, baseline: { id: state.apps.baseline.active, digest: state.deployments[state.apps.baseline.active].digest }, bodySha256: createHash('sha256').update(response.text).digest('hex') };
}
function phases(host, fixture) {
  return [
    ['idle', 10000, null],
    ['uploads', 20000, async () => {
      const responses = await Promise.all([1, 2].map(() => fixture.scoped('/v1/deployments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: fixture.upload.payload, timeoutMs: 120000 })));
      for (const response of responses) { assert.equal(response.status, 201); const submitted = response.json(); assert.equal(submitted.status, 'pending'); assert.equal(submitted.digest, fixture.upload.digest); fixture.submissions.push(submitted); }
      const state = (await fixture.request('/v1/admin')).json(); assert.equal(state.quota.retainedArtifactBytes, fixture.initialRetainedBytes + fixture.upload.artifactBytes * 2);
      return { simultaneousUploads: 2, artifactBytesEach: fixture.upload.artifactBytes, transportBytesEach: Buffer.byteLength(fixture.upload.payload), pendingOnly: true };
    }],
    ['activation', 45000, async () => {
      const submitted = fixture.submissions[2], approved = await host.json(['admin', 'approve', submitted.id, submitted.digest]);
      assert.equal(approved.status, 'active');
      return { app: 'peer', activeDigest: approved.digest };
    }],
    ['controller-outage', 30000, async () => {
      await ownCompose(host, ['stop', 'controller']); await delay(3000);
      await ownCompose(host, ['start', 'controller']);
      await waitFor('restarted serving controller', async () => (await fixture.request('/v1/admin')).status === 200);
      await waitFor('recovered baseline gateway', async () => { const response = await fixture.request('/api/messages', { app: 'baseline' }); return response.status === 200 && createHash('sha256').update(response.text).digest('hex') === fixture.bodySha256; });
      return { controllerStoppedAndStarted: true, intentionalStoppedDelayMs: 3000 };
    }],
    ['recovered', 10000, null],
  ];
}
async function window(host, observer, name, settings, action) {
  const session = await servingSession(host, observer, name, settings);
  let interference = null, started = false;
  try {
    await session.ready;
    if (action) {
      const start = await markServing(host, observer, 'start'); started = true;
      const outcome = await action(), end = await markServing(host, observer, 'end');
      interference = { start, end, outcome };
    }
    const report = await session.done; assert.equal(report.truncated, false); assert.deepEqual(report.summaries, servingReport(report.samples));
    for (const sample of report.samples) assert.ok(sample.startedMs >= report.startedMs && sample.finishedMs <= report.finishedMs);
    if (interference) {
      assert.equal(interference.start.time, report.markers.start); assert.equal(interference.end.time, report.markers.end);
      report.interference = { ...interference, overlappingReads: interferenceReads(report) };
    }
    if (name === 'idle' || name === 'recovered') { assert.equal(report.summaries.gateway.errors, 0); assert.equal(report.summaries.direct.errors, 0); }
    if (name === 'controller-outage') { assert.ok(report.interference.overlappingReads.gateway.statuses[503] > 0); assert.equal(report.summaries.direct.errors, 0); }
    return report;
  } catch (error) {
    if (started && !interference) await markServing(host, observer, 'end').catch(() => {});
    await session.done.catch(() => {}); throw error;
  }
}
async function startObserver(host, name, fleet) {
  const control = host.config.networks.control.name, node = host.config.services[fleet.nodes[0].host];
  const [key] = Object.keys(node.networks); const network = host.config.networks[key]?.name;
  assert.ok(network);
  await host.run('docker', ['run', '-d', '--pull', 'never', '--name', name, '--label', `fogd.qualifier.project=${host.project}`, '--network', control, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '1', '--entrypoint', '/usr/local/bin/node', host.entry.image, '-e', 'setInterval(()=>{},1000)']);
  await host.run('docker', ['network', 'connect', network, name]);
}
function ownCompose(host, args) {
  return host.run('docker', [...composeArgs(join(host.env.FOGD_HOME, '.fogd/installations', host.project, 'compose.json'), host.project), ...args]);
}
async function hardware(host) {
  const info = await json(['info', '--format', '{{json .}}']);
  return { hostNode: process.version, engine: { version: info.ServerVersion, os: info.OSType, architecture: info.Architecture, cpus: info.NCPU, memoryBytes: info.MemTotal, driver: info.Driver }, observer: { memoryBytes: 128 * 1024 ** 2, cpuLimit: 1 }, unrelatedContainers: (await docker(['ps', '-q'])).trim().split('\n').filter(Boolean).length - (await docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${host.project}`])).trim().split('\n').filter(Boolean).length };
}
async function controllerMetrics(host) {
  const [id] = (await docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${host.project}`, '--filter', 'label=com.docker.compose.service=controller'])).trim().split('\n'); assert.ok(id);
  const [container] = await json(['inspect', id]);
  const lines = (await host.run('docker', ['exec', id, 'cat', '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/cpu.stat'])).trim().split('\n');
  assert.match(lines[0], /^\d+$/); assert.match(lines[1], /^\d+$/);
  return { startedAt: container.State.StartedAt, memoryLimitBytes: container.HostConfig.Memory, nanoCPUs: container.HostConfig.NanoCpus,
    counters: { 'memory.current': lines[0], 'memory.peak': lines[1], 'cpu.stat': lines.slice(2).join('\n') } };
}
