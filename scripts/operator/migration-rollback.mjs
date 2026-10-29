import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedHostTrial } from '../cron-probe/selected/selected-trial.mjs';
import { selectedHostOptions } from '../cron-probe/selected/options.mjs';
import { stopSelectedHost } from '../cron-probe/selected/shutdown.mjs';
import { writeFixtures } from '../capacity/write-workload.mjs';
import { commandJson } from '../cron-probe/selected/commands.mjs';

const options = selectedHostOptions(process.argv.slice(2));
const migration = '20261029000100_ledger_atomicity.sql';
const diagnostic = 'fogd-after-marker-before-ledger';
const trigger = `CREATE TRIGGER fogd_ledger_atomicity BEFORE INSERT ON d1_migrations
WHEN NEW.name='${migration}' AND EXISTS(SELECT 1 FROM probe_writes WHERE id='ledger-sentinel')
BEGIN SELECT RAISE(ABORT,'${diagnostic}'); END;`;

await selectedHostTrial(options.output, 'Fresh two-fleet native SQL migration rollback after application SQL and before name-ledger insertion; two failed exact-artifact approvals, explicit fault removal and successful retry. Ordinary SQL failure only, no process interruption or power-loss claim.', async context => {
  const { source: host, evidence } = context, f = await writeFixtures(host), peer = f.submissions[1];
  assert.equal(host.entry.routing, 'durable');
  assert.equal((await host.json(['admin', 'approve', peer.id, peer.digest])).status, 'active');
  const written = await f.request('/api/write-probe', { app: 'peer', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'peer-record' }) });
  assert.equal(written.status, 200);
  const peerRows = (await f.request('/api/write-probe', { app: 'peer' })).json();
  assert.deepEqual(peerRows, [{ id: 'peer-record', app: 'peer' }]);
  const container = (await host.run('docker', ['inspect', '--format', '{{.Id}}', `${host.project}-controller-1`])).trim();
  evidence.before = await inspect(host, container, f.baseline);
  evidence.peerRows = peerRows;
  evidence.faultInstalled = await inspect(host, container, f.baseline, trigger);
  assert.equal(evidence.faultInstalled.triggers.length, 1);
  await writeFile(join(host.output, 'write-baseline-source/db/migrations', migration),
    "INSERT INTO probe_writes (id,app) VALUES ('ledger-sentinel','baseline');\n", { flag: 'wx', mode: 0o600 });
  const update = await host.json(['deploy', '--name', 'baseline'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: f.tokens.builder }, cwd: join(host.output, 'write-baseline-source') });
  assert.equal(update.status, 'pending'); f.submissions.push(update);
  evidence.update = { id: update.id, digest: update.digest };
  evidence.failures = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    context.phase = `ledger-rollback-attempt-${attempt}`;
    const approved = await failedApproval(host, update);
    assert.equal(approved.status, 'failed'); assert.equal(approved.step, 'migrating');
    assert.match(approved.error, new RegExp(diagnostic));
    const state = await inspect(host, container, update);
    assert.deepEqual(state.applied, evidence.before.applied);
    assert.deepEqual(state.rows, evidence.before.rows);
    assert.deepEqual(state.app.migrations, evidence.before.app.migrations);
    assert.equal(state.app.active, f.baseline.id); assert.equal(state.app.route, 'paused');
    assert.equal(state.app.uncertain, null); // Successful native-ledger reconciliation clears uncertainty.
    assert.equal(state.triggers.length, 1);
    evidence.failures.push({ attempt, state, http: await routing(f, 503, peerRows) });
  }
  context.phase = 'fault-removal-and-exact-retry';
  evidence.faultRemoved = await inspect(host, container, update, 'DROP TRIGGER fogd_ledger_atomicity;');
  assert.deepEqual(evidence.faultRemoved.triggers, []);
  const approved = await host.json(['admin', 'approve', update.id, update.digest]);
  assert.equal(approved.status, 'active'); assert.equal(approved.digest, update.digest);
  evidence.after = await inspect(host, container, update);
  assert.deepEqual(evidence.after.applied.map(row => row.name), [...evidence.before.applied.map(row => row.name), migration].sort());
  assert.deepEqual(evidence.after.rows, [{ id: 'ledger-sentinel', app: 'baseline' }, ...evidence.before.rows]);
  assert.equal(evidence.after.app.active, update.id); assert.equal(evidence.after.app.uncertain, null);
  assert.deepEqual(evidence.after.app.migrations, evidence.after.request.migrations);
  evidence.http = await routing(f, 200, peerRows);
  assert.deepEqual(evidence.http.baselineRows, evidence.after.rows);
  context.phase = 'clean-shutdown'; evidence.shutdown = await stopSelectedHost(host); host.closed = true;
  return f;
}, options.enrollment, options.hostOptions);

async function failedApproval(host, update) {
  let captured;
  await assert.rejects(host.command(['admin', 'approve', update.id, update.digest]), error => {
    captured = error; return Boolean(error.diagnosticFile);
  });
  const value = JSON.parse(await readFile(captured.diagnosticFile, 'utf8'));
  assert.equal(value.code, 1); assert.equal(value.signal, null);
  assert.match(value.stderr, /Activation failed; inspect the error above and explicitly approve again to retry/);
  return commandJson(value.stdout);
}

async function routing(f, expected, peerRows) {
  const baseline = await f.request('/api/write-probe', { app: 'baseline' }), peer = await f.request('/api/write-probe', { app: 'peer' });
  assert.equal(baseline.status, expected); assert.equal(peer.status, 200); assert.deepEqual(peer.json(), peerRows);
  return { baselineStatus: baseline.status, peerStatus: peer.status, peerRows: peer.json(), ...(expected === 200 ? { baselineRows: baseline.json() } : {}) };
}

async function inspect(host, container, deployment, sql) {
  // The owner CLI acts only on this new fixture's verified artifact and assigned D1 fleet.
  const code = `import assert from'node:assert/strict';import{readFile}from'node:fs/promises';
import{installedRuntimePolicy}from'/app/packages/platform/src/runtime-policy-file.mjs';import{selectedBackend}from'/app/packages/platform/src/startup.mjs';
import{artifactDigest}from'/app/packages/runtime/src/artifact.mjs';
const state=JSON.parse(await readFile('/var/lib/fogd/state.json','utf8')),request=state.deployments[${JSON.stringify(deployment.id)}],app=state.apps.baseline;
assert.equal(request?.app,'baseline');assert.equal(request.digest,${JSON.stringify(deployment.digest)});assert.equal(request.resources.d1.length,1);
const slot=JSON.parse(process.env.FOGD_SLOTS).find(value=>value.id===app.slot);assert.ok(slot);
const artifact='/var/lib/fogd/artifacts/'+request.id;assert.equal(await artifactDigest(artifact),request.digest);
const policy=await installedRuntimePolicy(process.env),backend=selectedBackend(undefined,policy,process.env);
const query=async sql=>(await backend.run(slot,['d1','execute',request.resources.d1[0].database_name,'--command',sql,artifact,'--json'])).trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line));
${sql ? `await query(${JSON.stringify(sql)});` : ''}
const applied=await query('SELECT name FROM d1_migrations ORDER BY name;'),rows=await query('SELECT id,app FROM probe_writes ORDER BY id;'),triggers=await query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name='fogd_ledger_atomicity';");
console.log(JSON.stringify({request:{id:request.id,digest:request.digest,status:request.status,step:request.step,error:request.error,migrations:request.migrations},app:{active:app.active,route:app.route,uncertain:app.uncertain,migrations:app.migrations},applied,rows,triggers}));`;
  return JSON.parse(await host.run('docker', ['exec', container, '/usr/local/bin/node', '--input-type=module', '-e', code]));
}
