import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { requireEmptyFleet } from '../../queue-probe/context.mjs';
import { refreshGateway } from '../gateway.mjs';
import { cronSQL } from '../sql.mjs';
import { cleanupCronProbe } from '../../cron-probe-cleanup.mjs';
import { expect } from '../../guestbook-browser.mjs';
import { vmNow, vmMinuteBoundary } from '../vm-time.mjs';
import { requireIdleHost } from './processes.mjs';
import { interruptionCase } from './policy.mjs';

export async function runInterruptionScenarios({ probe, stage, policy, progress = async () => {} }) {
  const boundary = () => vmMinuteBoundary(probe);
  let current, failure;
  const cases = [], intervals = [];
  const executable = '/app/qualification/interruption-controller.mjs', dir = policy.interruption.dir;
  async function launch(name, mode, fault = 'none') {
    const selected = interruptionCase(policy, name);
    assert.equal(selected.mode, mode); assert.equal(selected.fault, fault);
    await requireIdleHost(probe);
    const output = selected.output;
    const child = { output, name, terminal: false };
    child.running = probe.compose(['exec', '-T', 'controller', '/usr/local/bin/node', executable, name], { timeoutMs: 20 * 60000 })
      .then(text => { child.terminal = true; child.exitCode = 0; child.result = JSON.parse(text.trim()); }, error => { child.terminal = true; child.exitCode = error.exitCode; child.error = error; });
    current = child; return child;
  }
  async function readReceipt(child) {
    return JSON.parse(await probe.node(`import{readFile}from'node:fs/promises';try{console.log(await readFile(${JSON.stringify(`${child.output}/receipt.json`)},'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;console.log('null');}`));
  }
  async function receipt(child = current) {
    const value = await readReceipt(child);
    if (value?.step === 'failed') throw Error(value.failure);
    if (child.terminal && child.exitCode !== 0) throw Error(`Controller probe exited ${child.exitCode}`);
    return value;
  }
  async function waitReady(child) {
    await expect.poll(async () => (await receipt(child))?.step, { timeout: 120000 }).toBe('ready');
    return receipt(child);
  }
  async function send(operation, child = current) {
    const id = randomUUID();
    await probe.node(`import{writeFile,rename}from'node:fs/promises';const p=${JSON.stringify(`${child.output}/command.json`)};await writeFile(p+'.tmp',${JSON.stringify(JSON.stringify({ id, operation }))});await rename(p+'.tmp',p);`);
    return id;
  }
  async function finish(child = current) {
    const id = await send('finish', child);
    await expect.poll(async () => (await receipt(child))?.command?.id, { timeout: 30000 }).toBe(id);
    await child.running; assert.equal(child.exitCode, 0); assert.equal(child.result.step, 'complete');
    return child.result;
  }
  async function approve(child = current) {
    const requestedAt = await vmNow(probe);
    const id = await send('approve', child);
    await expect.poll(async () => (await receipt(child))?.command?.id, { timeout: 180000 }).toBe(id);
    const value = await receipt(child); assert.equal(value.state.target.status, 'active');
    assert.equal(value.adoptedApprovedVersion, true); assert.ok(value.approvalChecks > 0);
    assert.equal(value.state.active, value.state.target.id); assert.equal(value.state.route, 'active'); assert.equal(value.state.dispatch.hold, null);
    assert.ok(!value.events.some(event => event.startsWith('bootstrap:')));
    return { ...value, requestedAt };
  }
  async function kill(child = current) {
    const value = await readReceipt(child) || await locateChild(child);
    assert.ok(Number.isSafeInteger(value.pid) && value.pid > 1); assert.match(value.processStart, /^\d+$/);
    const code = `import{readFile}from'node:fs/promises';const pid=${value.pid};const args=(await readFile('/proc/'+pid+'/cmdline','utf8')).split('\\0');if(JSON.stringify(args.slice(0,-1))!==${JSON.stringify(JSON.stringify(['/usr/local/bin/node', executable, child.name]))})throw Error('Probe PID no longer matches');const start=(await readFile('/proc/'+pid+'/stat','utf8')).split(' ')[21];if(start!==${JSON.stringify(value.processStart)})throw Error('Probe PID was reused');process.kill(pid,'SIGKILL');`;
    await probe.node(code); await child.running; assert.equal(child.exitCode, 137, 'docker exec must report the real SIGKILL exit');
    await requireIdleHost(probe);
  }
  async function locateChild(child) {
    return JSON.parse(await probe.node(`import{readdir,readFile}from'node:fs/promises';const found=[];for(const pid of (await readdir('/proc')).filter(p=>/^\\d+$/.test(p))){try{const args=(await readFile('/proc/'+pid+'/cmdline','utf8')).split('\\0');if(JSON.stringify(args.slice(0,-1))===${JSON.stringify(JSON.stringify(['/usr/local/bin/node', executable, child.name]))})found.push({pid:Number(pid),processStart:(await readFile('/proc/'+pid+'/stat','utf8')).split(' ')[21]});}catch{}}if(found.length!==1)throw Error('Expected one matching probe controller');console.log(JSON.stringify(found[0]));`));
  }
  const native = async () => JSON.parse(await probe.cli(['cron', 'info', 'refresh', '--json']));
  async function ledger(artifact) {
    const sql = 'SELECT job,cron,scheduled_time,status,attempts,duplicates,completed_at FROM refresh_occurrences ORDER BY scheduled_time,job;';
    return cronSQL(probe, artifact, sql);
  }
  async function results(artifact) {
    return cronSQL(probe, artifact, 'SELECT job,cron,scheduled_time,value,saved_at FROM refresh_results ORDER BY scheduled_time,job;');
  }

  function assertRetained(before, after) {
    for (const row of before) assert.deepEqual(after.find(value => value.job === row.job && value.cron === row.cron && value.scheduled_time === row.scheduled_time), row);
  }
  function assertIdentity(expected, actual) {
    for (const key of ['id', 'digest', 'secretRevision']) assert.equal(actual[key], expected[key]);
  }
  function assertHeldIntervals(rows, intervals) {
    for (const { start, end } of intervals) assert.ok(!rows.some(row => row.scheduled_time >= start && row.scheduled_time < end), 'A late occurrence write must not hide dispatch during a held interval');
  }

  async function held(child, expectedDesired) {
    await progress(`${child.name}: checking restart hold`);
    const restored = await waitReady(child);
    assert.equal(restored.state.target.status, 'failed');
    assert.equal(restored.state.dispatch.hold, restored.state.target.id); assert.equal(restored.state.route, 'paused');
    assert.equal(restored.state.dispatch.desired, expectedDesired);
    assert.equal(restored.state.dispatch.observed, 'paused'); assert.equal(restored.state.dispatch.operation, null); assert.equal(restored.state.dispatch.recoveryError, null);
    assert.deepEqual(restored.startupEvents, ['pause:before', 'pause:after']);
    const runtime = await native(); assert.equal(runtime.paused, true); assert.equal(runtime.nextAlarm, null);
    const response = await refreshGateway(probe.env.FOGD_HTTP_PORT, '/api/refresh'); assert.equal(response.status, 503);
    assert.equal(await response.text(), 'App activation paused');
    const at = await boundary(), rows = await ledger(restored.artifact);
    assert.ok(rows.every(row => row.scheduled_time < at), 'A confirmed hold must suppress the next native occurrence');
    return { restored, native: runtime, boundary: at, rows };
  }
  async function cut(name, mode, point, { preapproval = false, waitForNativeResult = false } = {}) {
    await progress(`${name}: arming ${point} checkpoint`);
    const child = await launch(name, mode, point), ready = await waitReady(child);
    let preapprovalBoundary;
    if (preapproval) { preapprovalBoundary = await boundary(); await requireEmptyFleet(probe); }
    const approvalRequestedAt = await vmNow(probe);
    await send('approve', child);
    await expect.poll(async () => (await receipt(child))?.step, { timeout: 180000 }).toBe('checkpoint');
    const stoppedAt = await receipt(child); assert.equal(stoppedAt.point, point);
    assert.ok(stoppedAt.approvalChecks > 0);
    const beforeKill = await native();
    assert.equal(beforeKill.paused, point === 'publish');
    let nativeRows;
    if (waitForNativeResult) {
      await expect.poll(async () => { nativeRows = await ledger(ready.artifact); return ['advisory', 'inventory'].every(job => nativeRows.some(row => row.job === job && row.status === 'complete')); }, { timeout: 120000 }).toBe(true);
    }
    await kill(child);
    const disk = JSON.parse(await probe.node(`import{readFile}from'node:fs/promises';const s=JSON.parse(await readFile(${JSON.stringify(join(dir, 'state.json'))},'utf8'));const a=s.apps.refresh,d=s.deployments[${JSON.stringify(ready.state.target.id)}];console.log(JSON.stringify({id:d.id,digest:d.digest,status:d.status,step:d.step,secretRevision:d.secretRevision,hold:a.dispatch.hold,operation:a.dispatch.operation,desired:a.dispatch.desired,active:a.active,bootstrap:a.cronBootstrap.phase}));`));
    assert.equal(disk.id, ready.state.target.id); assert.equal(disk.digest, ready.state.target.digest);
    assert.equal(disk.status, 'activating'); assert.ok(disk.secretRevision); assert.equal(disk.secretRevision, stoppedAt.state.target.secretRevision);
    if (point === 'released') { assert.equal(disk.hold, null); assert.equal(disk.operation, null); }
    else { assert.equal(disk.hold, disk.id); if (point === 'resume') assert.equal(disk.operation, 'resume'); }
    const result = { name, ready, checkpoint: stoppedAt, beforeKill, nativeRows, disk, exitCode: child.exitCode, approvalRequestedAt, preapprovalBoundary };
    await probe.save(`${name}-cut`, result); return result;
  }
  async function liveResult(artifact, after, intervals) {
    let rows;
    await expect.poll(async () => { rows = await ledger(artifact); return rows.some(row => row.scheduled_time >= after && row.status === 'complete'); }, { timeout: 120000 }).toBe(true);
    assertHeldIntervals(rows, intervals);
    const response = await refreshGateway(probe.env.FOGD_HTTP_PORT, '/api/refresh'); assert.equal(response.status, 200);
    return rows;
  }
  try {
    const first = await cut('first-publication', 'initial', 'publish', { preapproval: true });
    assert.equal(first.checkpoint.migrationHold.before.paused, true); assert.equal(first.checkpoint.migrationHold.after.paused, true);
    const firstRecovery = await held(await launch('first-publication-recovery', 'recover'), 'running');
    assertIdentity(first.disk, firstRecovery.restored.state.target);
    assert.deepEqual(firstRecovery.rows, []); first.recovery = firstRecovery; await finish(); cases.push(first);

    const resume = await cut('first-resume', 'retry', 'resume', { waitForNativeResult: true });
    assertIdentity(first.disk, resume.ready.state.target);
    assert.ok(!resume.checkpoint.events.some(event => event.startsWith('bootstrap:')));
    intervals.push({ start: first.recovery.boundary, end: resume.approvalRequestedAt });
    assertHeldIntervals(resume.nativeRows, intervals);
    resume.recovery = await held(await launch('first-resume-recovery', 'recover'), 'running');
    assertIdentity(resume.disk, resume.recovery.restored.state.target);
    const resumed = await approve(); resume.explicitRetry = resumed;
    assertIdentity(resume.disk, resumed.state.target);
    intervals.push({ start: resume.recovery.boundary, end: resumed.requestedAt });
    resume.futureRows = await liveResult(resumed.artifact, resume.recovery.boundary + 60000, intervals);
    resume.results = await results(resumed.artifact); await finish(); cases.push(resume);

    const released = await cut('update-durable-release', 'update', 'released');
    assert.notEqual(released.disk.active, released.disk.id);
    released.recovery = await held(await launch('update-release-recovery', 'recover'), 'running');
    assertIdentity(released.disk, released.recovery.restored.state.target);
    const updated = await approve(); released.explicitRetry = updated;
    assertIdentity(released.disk, updated.state.target);
    intervals.push({ start: released.recovery.boundary, end: updated.requestedAt });
    released.futureRows = await liveResult(updated.artifact, released.recovery.boundary + 60000, intervals);
    released.results = await results(updated.artifact); assertRetained(resume.results, released.results); await finish(); cases.push(released);

    const paused = await cut('paused-update-publication', 'paused-update', 'publish');
    assert.equal(paused.disk.desired, 'paused');
    paused.recovery = await held(await launch('paused-update-recovery', 'recover'), 'paused');
    assertIdentity(paused.disk, paused.recovery.restored.state.target);
    const activated = await approve(); assert.equal(activated.state.dispatch.desired, 'paused'); assert.equal(activated.state.dispatch.hold, null);
    assertIdentity(paused.disk, activated.state.target);
    assert.ok(!activated.events.some(event => /^resume:/.test(event)));
    const finalNative = await native(); assert.equal(finalNative.paused, true); assert.equal(finalNative.nextAlarm, null);
    const finalBoundary = await boundary(), settledBoundary = await boundary(), finalRows = await ledger(activated.artifact);
    intervals.push({ start: paused.recovery.boundary, end: settledBoundary });
    assertHeldIntervals(finalRows, intervals);
    paused.explicitRetry = activated; paused.finalBoundary = finalBoundary; paused.settledBoundary = settledBoundary; paused.finalRows = finalRows;
    paused.results = await results(activated.artifact); assertRetained(released.results, paused.results);
    assert.equal((await refreshGateway(probe.env.FOGD_HTTP_PORT, '/api/refresh')).status, 200);
    await finish(); cases.push(paused);
    await probe.save('interruptions', { cases, dir, heldIntervalsRecheckedAfterLaterNativeWork: intervals, nativeDeclarations: stage.source.triggers,
      scope: 'Ordinary Void job code privately staged with image-pinned case artifacts and guarded release transport. Actual controller SIGKILL at selected native boundaries. Held intervals check occurrence identities, not entry times of running callbacks or retries. Direct Controller construction, not startController, scoped upload, admin API or TLS. Cleanup pauses native dispatch without updating the journal. No corrected-artifact replacement, general handler overlap or snapshot recovery claim; other receipts retain their own source/runtime scope.' });
  } catch (error) { failure = error; await probe.save('activation-failure', { message: error.message, cases }); throw error; }
  finally {
    if (current && !current.terminal) { try { await kill(current); } catch { console.error('Probe controller termination failed; stop the disposable installation'); } }
    try { await cleanupCronProbe(probe, () => probe.cleanupPause()); }
    catch (error) { if (!failure) throw error; console.error('Cleanup failed; stop the disposable fleet and retain private evidence'); }
  }

  return { cases, dir, heldIntervalsRecheckedAfterLaterNativeWork: intervals, nativeDeclarations: stage.source.triggers };
}
