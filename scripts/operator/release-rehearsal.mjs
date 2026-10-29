import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { releaseTransfer, verifyReceivedProgram } from './release-transfer.mjs';
import { freshReceivedHost } from './release-host.mjs';
import { receivedApplications, receivedRecovery, releaseCheckpoint, acknowledgedWrite, applicationRows, nativeLedger } from './release-workflow.mjs';
import { waitFor } from '../cron-probe/selected/https.mjs';
import { receivedReplicaReadiness } from './release-readiness.mjs';
import { sourceState, sourceInventory, archiveSources } from '../cron-probe/selected/evidence.mjs';
import { stopSelectedHost } from '../cron-probe/selected/shutdown.mjs';
import { cleanupSelectedHost } from '../cron-probe/selected/host.mjs';
import { scanOutputFiles } from '../cron-probe/selected/privacy.mjs';
import { runtimeFamily } from '../../packages/cli/src/runtime/catalog.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'source-context': { type: 'string' }, released: { type: 'boolean', default: false }, runtime: { type: 'string', default: 'celld-durable-v5-linux-arm64' } } });
if (positionals.length !== 1 || !values['source-context'] || !process.env.DOCKER_CONTEXT || values['source-context'] === process.env.DOCKER_CONTEXT) throw new Error('Select distinct source and target Docker contexts and one new private output directory');
const output = resolve(positionals[0]); await mkdir(output, { mode: 0o700 });
const provenance = await sourceState(), sources = await sourceInventory(); await archiveSources(output, provenance, sources, new URL(import.meta.url));
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const catalog = await readFile(new URL('../../packages/cli/src/runtime/catalog.json', import.meta.url)), hosts = [], evidence = {}; let phase = values.released ? 'released-transfer' : 'private-release-transfer';
assert.equal(runtimeFamily(values.runtime, 'enrolled').admission, values.released ? 'qualified' : 'candidate');
const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  evidence.transfer = await releaseTransfer(output, values['source-context'], { released: values.released, runtime: values.runtime });
  phase = 'public-selector-enrollment'; const source = await freshReceivedHost(evidence.transfer.received, join(output, 'installation'), hosts, { runtime: values.runtime });
  evidence.source = { project: source.project, policy: source.policy, initialServices: source.initialServices, tlsRefusal: source.tlsRefusal };
  const f = await receivedApplications(source, evidence, value => { phase = value; });
  phase = 'received-stopped-backup'; const bundle = join(output, 'snapshot');
  await source.command(['backup', bundle, '--installation', source.project], { timeout: 600000 });
  evidence.snapshot = JSON.parse(await readFile(join(bundle, 'manifest.json')));
  phase = 'received-public-restore'; const target = await receivedRecovery(source, join(output, 'recovery'), bundle, hosts);
  evidence.target = { project: target.project, policy: target.policy, initialServices: target.initialServices, sourceFenceRefusal: target.sourceFenceRefusal };
  phase = 'withheld-target-and-explicit-resume'; evidence.resume = {}; evidence.nativeBeforeResume = {};
  await waitFor('received recovered admin API', async () => (await f.request('/v1/admin')).status === 200);
  for (const app of ['baseline', 'peer']) {
    assert.equal((await f.request('/api/write-probe', { app })).status, 503);
    const active = evidence.approvals[app], readiness = {}; evidence.nativeBeforeResume[app] = readiness;
    const status = await receivedReplicaReadiness(target, app, active, readiness);
    const resumed = await target.json(['admin', 'routing', app, 'resume', active.id, active.digest]); assert.equal(resumed.state, 'active'); evidence.resume[app] = { before: status, after: resumed };
  }
  evidence.afterRecovery = await releaseCheckpoint(target, f, evidence.beforeUpdate, evidence.pending);
  evidence.restoredLedger = await nativeLedger(target, evidence.approvals.baseline); assert.deepEqual(evidence.restoredLedger, evidence.approvedLedger);
  await acknowledgedWrite(f, 'baseline', 'after-recovery'); evidence.afterRecoveryWrite = await applicationRows(f);
  assert.deepEqual(evidence.afterRecoveryWrite.baseline, [{ id: 'after-recovery', app: 'baseline' }, ...evidence.beforeUpdate.baseline]); assert.deepEqual(evidence.afterRecoveryWrite.peer, evidence.beforeUpdate.peer);
  phase = 'retained-shutdown'; await target.command(['stop', '--installation', target.project]);
  evidence.shutdown = [];
  for (const host of hosts) { evidence.shutdown.push({ project: host.project, ...await stopSelectedHost(host, { alreadyStopped: true }) }); host.closed = true; }
  evidence.receivedProgram = await verifyReceivedProgram(evidence.transfer);
  assert.deepEqual(await readFile(new URL('../../packages/cli/src/runtime/catalog.json', import.meta.url)), catalog);
  assert.equal(runtimeFamily(values.runtime, 'enrolled').admission, values.released ? 'qualified' : 'candidate');
  assert.deepEqual(await sourceState(), provenance); assert.deepEqual(await sourceInventory(), sources);
  const receipt = { actualReleasedCatalog: values.released, scope: values.released ? 'Actual qualified repository catalog copied without changes. Public transfer, enrollment, received client update/restart and fresh stopped recovery on a distinct existing Docker engine on the same physical host. Prepared fixture dependencies supplied; no registry publication or separate-machine claim.' : 'Private proposed-release rehearsal only. One catalog admission field changed in a private exported copy; main admission stays closed. Public transfer, enrollment, received client update/restart and fresh stopped recovery on a distinct existing Docker engine on the same physical host. Prepared fixture dependencies supplied; no registry publication or separate-machine claim.', provenance, sources, family: source.entry.id, image: source.entry.image, evidence };
  receipt.privacy = await scanOutputFiles(hosts, f, receipt); await save('result.json', receipt);
  const bytes = await readFile(join(output, 'result.json')); await save('post-write-privacy.json', { sha256: createHash('sha256').update(bytes).digest('hex'), ...await scanOutputFiles(hosts, f, receipt, [bytes]) });
  console.log(values.released ? 'PASS-actual-released-catalog' : 'PASS-proposed-release-rehearsal');
} catch (error) { await save('failure.json', { phase, name: error.name, message: error.message, evidence }); throw error; }
finally { clearInterval(heartbeat); for (const host of hosts.filter(host => !host.closed).reverse()) await cleanupSelectedHost(host); }
