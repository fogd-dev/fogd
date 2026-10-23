import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedHostTrial } from './selected-trial.mjs';
import { copyFixture } from './project-copy.mjs';
import { httpsClient, waitFor } from './https.mjs';
import { scanPublicSurfaces } from './privacy.mjs';
import { stopSelectedHost } from './shutdown.mjs';
import { projectContainers, stopped } from '../../../packages/cli/src/recovery/docker.mjs';

await selectedHostTrial(process.argv[2], 'Public enrolled Docker stop/start: saved D1 data, an inert pending submission, canonical selection despite a wrong profile project/template, idempotent ordered stop, unchanged saved configuration, and retained resources. HTTP/D1 only; no new background pause, backup or cross-host recovery qualification.', async context => {
  const { source: host, evidence } = context, request = await httpsClient(host);
  await waitFor('lifecycle owner API', async () => (await request('/v1/admin')).status === 200);
  const token = (await host.json(['admin', 'issue-token', 'lifecycle-builder', 'baseline,replacement'])).token;
  const fixture = { tokens: { builder: token }, secret: token };
  const project = await copyFixture(host, 'guestbook', 'lifecycle-guestbook');
  const migration = join(project, 'db/migrations/20261016160656_complete_ser_duncan.sql');
  await writeFile(migration, (await readFile(migration, 'utf8')) + "\nINSERT INTO messages(id,text,created_at) VALUES(1,'lifecycle-preserved-row','2026-10-22 12:00:00');\n");
  context.phase = 'lifecycle-submissions';
  const submit = name => host.json(['deploy', '--name', name], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token }, cwd: project });
  const active = await submit('baseline'); await host.json(['admin', 'approve', active.id, active.digest]);
  const pending = await submit('replacement'); assert.equal(pending.status, 'pending');
  evidence.active = active; evidence.pending = pending; evidence.initialRows = await rows(request);
  const canonical = join(host.env.FOGD_HOME, '.fogd/installations', host.project, 'compose.json');
  const before = await readFile(canonical), settings = await readFile(host.env.FOGD_ENV_FILE);
  const originalIds = (await projectContainers(host.project)).map(container => container.Id).sort();
  const selected = { ...host.env, COMPOSE_PROJECT_NAME: 'not-this-installation', FOGD_COMPOSE_FILE: '/private/not-this-template',
    FOGD_ADMIN_PASSWORD: '', FOGD_DEPLOY_TOKEN: '', FOGD_SERVER: 'http://127.0.0.1:1' };
  context.phase = 'public-stop';
  evidence.stopped = await host.json(['stop', '--installation', host.project], { env: selected });
  assert.equal(evidence.stopped.status, 'stopped'); assert.equal(evidence.stopped.backupCreated, false); assert.equal(evidence.stopped.backgroundPause, 'unchanged');
  assert.deepEqual(evidence.stopped.missingVolumes, []); assert.equal(evidence.stopped.retainedVolumes.length, 8);
  await stopped(host.project, evidence.stopped.retainedVolumes);
  assert.deepEqual((await projectContainers(host.project)).map(container => container.Id).sort(), originalIds);
  assert.deepEqual(await readFile(canonical), before); assert.deepEqual(await readFile(host.env.FOGD_ENV_FILE), settings);
  await assert.rejects(request('/v1/admin'));
  evidence.repeatedStop = await host.json(['stop', '--installation', host.project], { env: selected });
  assert.deepEqual(evidence.repeatedStop, evidence.stopped);
  context.phase = 'public-restart';
  await host.command(['up', '--installation', host.project]);
  await waitFor('restarted lifecycle application', async () => { const data = await rows(request); assert.deepEqual(data, evidence.initialRows); return true; });
  evidence.restartedRows = await rows(request);
  const state = (await request('/v1/admin')).json();
  assert.equal(state.apps.baseline.active, active.id); assert.equal(state.deployments[pending.id].status, 'pending'); assert.equal(state.apps.replacement, undefined);
  const unavailable = await request('/api/messages', { app: 'replacement' }); assert.equal(unavailable.status, 404);
  evidence.pendingAfterRestart = { id: pending.id, status: state.deployments[pending.id].status, applicationHTTPStatus: unavailable.status };
  evidence.privacy = await scanPublicSurfaces(host, request, [active, pending], token, [], evidence);
  context.phase = 'final-public-stop';
  evidence.finalStop = await host.json(['stop', '--installation', host.project]);
  await stopped(host.project, evidence.finalStop.retainedVolumes);
  evidence.shutdown = await stopSelectedHost(host, { alreadyStopped: true }); host.closed = true;
  assert.equal(evidence.shutdown.retainedVolumes.length, 8);
  return fixture;
});

async function rows(request) {
  const response = await request('/api/messages', { app: 'baseline' }); assert.equal(response.status, 200);
  const data = response.json(); assert.equal(data.length, 1); assert.equal(data[0].text, 'lifecycle-preserved-row'); return data;
}
