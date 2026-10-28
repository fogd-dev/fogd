import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { controllerState, nativeObservation, vmTime, setFaultPolicy } from './observations.mjs';
import { activeBackground } from './background-lifecycle.mjs';
import { beginFailurePhase, firstFailureOccurrence, hasSuccessfulOccurrence, pauseFailureWork } from './failure-phases.mjs';
import { resumeCron, futurePhase } from './recovery-work.mjs';
import { rows } from './recovery-ledger.mjs';
import { waitFor } from './https.mjs';
import { queuedInput, completeQueuedInput } from './retirement-steps.mjs';

export async function compatibleBackgroundUpdate(host, fixture) {
  const active = fixture.approvals.refresh, held = await pauseFailureWork(host, active, () => vmTime(host));
  const migration = '0003_v4_update.sql';
  await writeFile(join(fixture.project, 'db/migrations', migration), 'CREATE TABLE v4_background_update (id INTEGER PRIMARY KEY);\nINSERT INTO v4_background_update VALUES (1);\n', { flag: 'wx', mode: 0o600 });
  const route = join(fixture.project, 'routes/api/refresh.ts'), original = await readFile(route, 'utf8'), marker = 'defineHandler(c => summary(c.env.DB))';
  assert.equal(original.split(marker).length, 2);
  await writeFile(route, original.replace(marker, "defineHandler(async c => ({ ...await summary(c.env.DB), release: 'v4-update' }))"));
  for (const job of ['inventory', 'advisory']) {
    const file = join(fixture.project, 'crons', `${job}.ts`), source = await readFile(file, 'utf8');
    assert.equal(source.split('export const cron = "* * * * *";').length, 2);
    await writeFile(file, source.replace('export const cron = "* * * * *";', 'export const cron = "*/3 * * * *";'));
  }
  const submitted = await host.json(['deploy', '--name', 'refresh'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: fixture.tokens.refresh }, cwd: fixture.project });
  assert.equal(submitted.status, 'pending'); assert.notEqual(submitted.digest, active.digest); fixture.submissions.refresh.push(submitted);
  const approved = await host.json(['admin', 'approve', submitted.id, submitted.digest, active.secretRevision]); assert.equal(approved.status, 'active');
  fixture.approvals.refresh = activeBackground(await controllerState(host), 'refresh');
  const observed = await nativeObservation(host, active.slot, submitted.id, { persistedRecords: true });
  assert.equal(observed.status.paused, true); assert.equal(observed.status.nextAlarm, null);
  for (const table of ['cron_fault_attempts', 'refresh_occurrences', 'refresh_results']) assert.deepEqual(rows(observed, table), rows(held.observed, table));
  assert.ok(observed.databases.some(database => database.migrations.some(value => value.name === migration)));
  const response = await fixture.request('/api/refresh', { app: 'refresh' }); assert.equal(response.status, 200); assert.equal(response.json().release, 'v4-update');
  return { held, submitted, active: fixture.approvals.refresh, observed, http: { status: response.status, body: response.json() }, cron: '*/3 * * * *' };
}

export async function nativeBackgroundRetry(host, active) {
  const phase = await beginFailurePhase(host, active, 'retry-control', () => vmTime(host));
  const first = await firstFailureOccurrence(host, active, phase, '*/3 * * * *');
  assert.ok(first.attempts.some(row => row.job === 'advisory' && row.outcome === 'thrown' && row.no_retry_called === 0));
  const completed = await waitFor('original sparse cron occurrence recovers after native retry', async () => {
    const observed = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    return hasSuccessfulOccurrence(observed, first.time) && observed;
  }, 150000);
  const attempts = rows(completed, 'cron_fault_attempts').filter(row => row.phase === 'retry-control' && row.scheduled_time === first.time);
  assert.ok(attempts.filter(row => row.job === 'advisory' && row.outcome === 'thrown').length >= 2);
  for (const job of ['inventory', 'advisory']) assert.equal(rows(completed, 'refresh_results').filter(row => row.job === job && row.scheduled_time === first.time).length, 1);
  return { phase, first, completed, attempts };
}

export async function scheduledWorkWhileHTTPPaused(host, fixture) {
  const active = fixture.approvals.refresh;
  const pause = await host.json(['admin', 'routing', 'refresh', 'pause', active.id, active.digest]);
  const withheld = await fixture.request('/api/refresh', { app: 'refresh' }); assert.equal(withheld.status, 503);
  await setFaultPolicy(host, active.slot, active.id, 'healthy', 'after-a');
  const resumed = await resumeCron(host, active), work = await futurePhase(host, active, 'after-a', resumed.requestedAt, 260000);
  const stillWithheld = await fixture.request('/api/refresh', { app: 'refresh' }); assert.equal(stillWithheld.status, 503);
  const resume = await host.json(['admin', 'routing', 'refresh', 'resume', active.id, active.digest]);
  const response = await fixture.request('/api/refresh', { app: 'refresh' }); assert.equal(response.status, 200); assert.equal(response.json().release, 'v4-update');
  return { pause, beforeHTTP: withheld.status, resumed, work, afterWorkHTTP: stillWithheld.status, resume, afterResumeHTTP: response.status };
}

export async function queuedWorkWhileHTTPPaused(host, fixture) {
  const active = fixture.approvals.imports;
  const pending = await queuedInput(host, fixture.request, active, 'http-paused-input', 'mango\nplum', ['MANGO', 'PLUM']);
  const pause = await host.json(['admin', 'routing', 'imports', 'pause', active.id, active.digest]);
  assert.equal((await fixture.request('/api/imports', { app: 'imports' })).status, 503);
  const work = await completeQueuedInput(host, active, pending);
  assert.equal((await fixture.request('/api/imports', { app: 'imports' })).status, 503);
  const resume = await host.json(['admin', 'routing', 'imports', 'resume', active.id, active.digest]);
  const response = await fixture.request('/api/imports', { app: 'imports' }); assert.equal(response.status, 200);
  return { pending, pause, beforeHTTP: 503, work, afterWorkHTTP: 503, resume, afterResumeHTTP: response.status };
}
