import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedHostTrial } from '../cron-probe/selected/selected-trial.mjs';
import { selectedHostOptions } from '../cron-probe/selected/options.mjs';
import { openControllerDebugger, killController } from '../cron-probe/selected/controller-debugger.mjs';
import { waitFor } from '../cron-probe/selected/https.mjs';
import { stopSelectedHost } from '../cron-probe/selected/shutdown.mjs';
import { writeFixtures } from '../capacity/write-workload.mjs';
import { ownCompose } from '../capacity/serving-host.mjs';

const options = selectedHostOptions(process.argv.slice(2));
const migration = '20261028000100_retry_gap.sql';
await selectedHostTrial(options.output, 'Native SQL migration committed before controller hash-ledger save: source-verified application checkpoints, controller process interruption, withheld HTTP and exact-artifact retry without reentering backend migration. Fresh two-fleet installation only; no native SQL/bookkeeping atomicity or power-loss claim.', async context => {
  const { source: host, evidence } = context, f = await writeFixtures(host), peer = f.submissions[1];
  assert.equal(host.entry.routing, 'durable');
  assert.equal((await host.json(['admin', 'approve', peer.id, peer.digest])).status, 'active');
  const write = await f.request('/api/write-probe', { app: 'peer', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'peer-record' }) });
  assert.equal(write.status, 200);
  const before = (await f.request('/v1/admin')).json(), peerRows = (await f.request('/api/write-probe', { app: 'peer' })).json();
  const baselineRows = (await f.request('/api/write-probe', { app: 'baseline' })).json();
  await writeFile(join(host.output, 'write-baseline-source/db/migrations', migration),
    "CREATE TABLE migration_retry_probe (id TEXT PRIMARY KEY NOT NULL);\nINSERT INTO migration_retry_probe (id) VALUES ('committed-once');\n", { flag: 'wx', mode: 0o600 });
  const update = await host.json(['deploy', '--name', 'baseline'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: f.tokens.builder }, cwd: join(host.output, 'write-baseline-source') });
  assert.equal(update.status, 'pending'); f.submissions.push(update);
  const container = (await host.run('docker', ['inspect', '--format', '{{.Id}}', `${host.project}-controller-1`])).trim();
  let session = await openControllerDebugger(container, host.project, host.entry.id);
  try {
    const checkpoint = await session.debuggerSession.breakpoint({ path: 'packages/platform/src/controller.mjs', marker: 'app.uncertain = null; await this.save();', functionName: 'reconcileLedger' });
    context.phase = 'migration-ledger-checkpoints';
    const approval = host.command(['admin', 'approve', update.id, update.digest]).then(() => ({ completed: true }), () => ({ completed: false }));
    const first = await session.debuggerSession.paused(checkpoint), initial = await snapshot(host, container, update.id);
    assert.deepEqual(initial.applied.map(row => row.name), before.apps.baseline.migrations.map(row => row.name));
    assert.deepEqual(initial.markers, []);
    session.debuggerSession.assertPaused(first.pauseSequence); await session.debuggerSession.resume();
    const second = await session.debuggerSession.paused(checkpoint), committed = await snapshot(host, container, update.id);
    assert.deepEqual(committed.applied.map(row => row.name), [...initial.applied.map(row => row.name), migration].sort());
    assert.deepEqual(committed.app.migrations, before.apps.baseline.migrations);
    assert.equal(committed.app.uncertain, update.id); assert.equal(committed.request.step, 'migrating'); assert.equal(committed.request.status, 'activating');
    assert.deepEqual(committed.markers, [{ id: 'committed-once' }]);
    evidence.http = { beforeInterruption: await routing(f, 503, peerRows) };
    session.debuggerSession.assertPaused(second.pauseSequence);
    evidence.controllerIdentity = session.identity;
    evidence.interruption = await killController(session.identity);
    evidence.interruptedApproval = await approval; assert.equal(evidence.interruptedApproval.completed, false);
    await session.debuggerSession.close().catch(() => {}); session = null;
    evidence.before = initial; evidence.committedBeforeHashSave = committed; evidence.checkpoint = checkpoint;
    context.phase = 'explicit-retry';
    await ownCompose(host, ['start', 'controller']);
    await waitFor('interrupted controller restart', async () => (await f.request('/v1/admin')).status === 200);
    const recovered = (await f.request('/v1/admin')).json();
    assert.equal(recovered.deployments[update.id].status, 'failed'); assert.equal(recovered.apps.baseline.uncertain, update.id);
    evidence.recovered = { status: recovered.deployments[update.id].status, step: recovered.deployments[update.id].step, uncertain: recovered.apps.baseline.uncertain };
    evidence.http.afterRestart = await routing(f, 503, peerRows);
    session = await openControllerDebugger(container, host.project, host.entry.id);
    const forbidden = await session.debuggerSession.breakpoint({ path: 'packages/platform/src/backend.mjs', marker: "for (const db of resources.d1) await this.run(slot, ['d1', 'migrations'", functionName: 'migrate' });
    const approved = await host.json(['admin', 'approve', update.id, update.digest]);
    // Reentering native migration would pause before completing this request.
    assert.equal(approved.status, 'active');
    evidence.retry = { approved: { id: approved.id, digest: approved.digest, status: approved.status }, migrationCheckpointArmedUntilApproval: forbidden };
    await session.debuggerSession.close(); session = null;
    const after = await snapshot(host, container, update.id);
    assert.equal(after.app.uncertain, null);
    assert.deepEqual(after.app.migrations, after.request.migrations);
    assert.deepEqual(after.app.migrations.map(row => row.name), committed.applied.map(row => row.name));
    assert.deepEqual(after.applied, committed.applied); assert.deepEqual(after.markers, committed.markers);
    evidence.http.afterRetry = await routing(f, 200, peerRows);
    assert.deepEqual(evidence.http.afterRetry.baselineRows, baselineRows);
    evidence.after = after; evidence.peerRows = peerRows;
    context.phase = 'clean-shutdown'; evidence.shutdown = await stopSelectedHost(host); host.closed = true;
    return f;
  } finally { if (session) await session.debuggerSession.close().catch(() => {}); }
}, options.enrollment, options.hostOptions);

async function routing(f, expected, peerRows) {
  const baseline = await f.request('/api/write-probe', { app: 'baseline' }), peer = await f.request('/api/write-probe', { app: 'peer' });
  assert.equal(baseline.status, expected); assert.equal(peer.status, 200); assert.deepEqual(peer.json(), peerRows);
  return { baselineStatus: baseline.status, peerStatus: peer.status, peerRows: peer.json(), ...(expected === 200 ? { baselineRows: baseline.json() } : {}) };
}

async function snapshot(host, container, deployment) {
  const code = `import{readFile}from'node:fs/promises';import{Backend}from'/app/packages/platform/src/backend.mjs';
const state=JSON.parse(await readFile('/var/lib/fogd/state.json','utf8')),request=state.deployments[${JSON.stringify(deployment)}],app=state.apps[request.app];
const slot=JSON.parse(process.env.FOGD_SLOTS).find(value=>value.id===app.slot),backend=new Backend();
const query=async sql=>(await backend.run(slot,['d1','execute',request.resources.d1[0].database_name,'--command',sql,'/var/lib/fogd/artifacts/'+request.id,'--json'])).trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line));
const applied=await query('SELECT name FROM d1_migrations ORDER BY name;'),tables=await query("SELECT name FROM sqlite_master WHERE name='migration_retry_probe';");
const markers=tables.length?await query('SELECT id FROM migration_retry_probe ORDER BY id;'):[];
console.log(JSON.stringify({request:{id:request.id,digest:request.digest,status:request.status,step:request.step,migrations:request.migrations},app:{active:app.active,uncertain:app.uncertain,migrations:app.migrations},applied,markers}));`;
  return JSON.parse(await host.run('docker', ['exec', container, '/usr/local/bin/node', '--input-type=module', '-e', code]));
}
