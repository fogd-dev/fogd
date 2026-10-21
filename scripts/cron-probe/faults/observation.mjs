// Immutable, read-only observation of the narrow pre-kill retry window.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { artifactDigest } from '/app/packages/runtime/src/artifact.mjs';
import { qualificationPolicy } from './backend.mjs';
import { activeRelease } from './release-policy.mjs';
import contract from './release-contract.mjs';
import { readCronRecords } from './read-records.mjs';

assert.deepEqual(process.execArgv, []); assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.argv.length, 4); assert.deepEqual(process.argv.slice(0, 2), ['/usr/local/bin/node', '/app/qualification/failure-observation.mjs']);
const time = Number(process.argv[2]);
// Arguments select a scheduled occurrence and fixed observation mode; no path, SQL, host or executable is supplied.
const recovering = process.argv[3] === 'owner-recovery'; assert.ok(['owner-loss', 'owner-recovery'].includes(process.argv[3])); assert.ok(Number.isSafeInteger(time) && time > 0 && time % 60000 === 0);
const startedAt = Date.now(), policy = await qualificationPolicy();
assert.equal(contract.kind, 'failures');
const state = JSON.parse(await readFile('/var/lib/fogd/state.json', 'utf8'));
assert.equal(activeRelease(policy, contract, state), 'fast');
const active = state.deployments[state.apps.refresh.active]; assert.match(active.id, /^[a-f0-9-]{36}$/);
const artifact = `/var/lib/fogd/artifacts/${active.id}`;
const slot = policy.fleets.find(fleet => fleet.id === policy.releases.slot);
const env = { ...process.env, CELLD_BUCKET: `s3://${policy.bucket}/${slot.prefix}` }, execute = promisify(execFile);
const cli = async args => (await execute('/usr/local/bin/celld', args, { env, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const latencies = {};
const measured = async (name, run) => { const start = Date.now(); try { return await run(); } finally { latencies[name] = Date.now() - start; } };
const [ledger, bucket, digest] = await Promise.all([measured('ledger', () => cli(['d1', 'execute', 'refresh-db', '--command', 'SELECT * FROM cron_fault_attempts ORDER BY entered_at,id;', artifact, '--json'])).then(text => ({ text }), error => { if (!recovering) throw error; return { error: { code: String(error.code || 'COMMAND_FAILED'), killed: !!error.killed, signal: error.signal || null } }; }), measured('bucket', readCronRecords), measured('artifact', () => artifactDigest(artifact))]);
assert.equal(active.digest, digest);
const phaseRows = ledger.text?.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.phase === 'owner-loss');
if (recovering) {
  console.log(JSON.stringify({ rows: phaseRows, ledgerError: ledger.error, bucket, latencies, startedAt, completedAt: Date.now() }));
  process.exit(0);
}
const rows = phaseRows.filter(row => row.scheduled_time === time);
assert.ok(slot.nodes.some(node => node.host === bucket.owner.node));
const [infoText, deployment] = await Promise.all([measured('cronInfo', () => cli(['cron', 'info', 'refresh', '--json'])), measured('ownerState', async () => {
  const response = await fetch(`http://${bucket.owner.node}:8081/state`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.ok, true); return (await response.json()).deployment;
})]);
const info = JSON.parse(infoText);
console.log(JSON.stringify({ rows, bucket, info, deployment, artifact, latencies, startedAt, completedAt: Date.now() }));
