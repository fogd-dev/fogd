import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect } from '../../guestbook-browser.mjs';
import { projectContainers, stopped } from '../../../packages/cli/src/recovery/docker.mjs';
import { compareSourceVolumes } from './preservation.mjs';
import { assertShutdown } from './oracles.mjs';
import { waitForController } from './client.mjs';
import { vmNow } from '../vm-time.mjs';
import { data, native } from './data.mjs';

export async function bootstrap(probe, runner) {
  assert.equal((await projectContainers(probe.project)).length, 0, 'Use a fresh qualification project');
  await probe.compose(['create', '--pull', 'never']);
  await probe.compose(['cp', `${runner}/.`, 'controller:/var/lib/fogd/qualification']);
  await probe.prepareControllerData?.();
  await probe.compose(['up', '-d', '--no-build', '--pull', 'never']);
  await waitForController(probe);
  const id = randomUUID();
  await probe.compose(['exec', '-T', 'controller', 'node', '--input-type=module', '-e', `import{saveJson}from'./packages/platform/src/store.mjs';await saveJson('/var/lib/fogd/qualification/command.json',${JSON.stringify({ id, operation: 'stage' })});`]);
  let result;
  await expect.poll(async () => {
    const value = await probe.compose(['exec', '-T', 'controller', 'node', '--input-type=module', '-e', "import{readJson}from'./packages/platform/src/store.mjs';console.log(JSON.stringify(await readJson('/var/lib/fogd/qualification/result.json',null))); "]);
    result = JSON.parse(value); return result?.id;
  }, { timeout: 180000 }).toBe(id);
  assert.equal(result.slot, 'slot-1');
  const release = await probe.submit(join(process.cwd(), 'examples/imports'), 'imports');
  assert.equal((await probe.decide(release)).status, 'active');
  const admin = await probe.api('/v1/admin');
  probe.backgroundApps = { refresh: 'dispatch', imports: 'delivery' };
  probe.approvals = Object.fromEntries(['refresh', 'imports'].map(name => {
    const app = admin.apps[name], active = admin.deployments[app.active];
    assert.ok(Object.hasOwn(active, 'secretRevision'));
    return [name, { slot: app.slot, deployment: active.id, digest: active.digest, secretRevision: active.secretRevision ?? null }];
  }));
  return probe.approvals;
}
export async function snapshot(probe, directory, expectedAlarm, selected) {
  assert.ok(expectedAlarm > await vmNow(probe));
  const before = await data(probe);
  assert.ok(!before.attempts.some(row => row.outcome === 'pending'), 'Use a quiescent callback boundary with the selected timer or retry still armed');
  await probe.command(['backup', directory]); probe.daemon = false;
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  for (const [name, pinned] of Object.entries(manifest.images)) if (name !== 'minio') assert.equal(pinned, probe.identity.image, 'Every selected runtime must use the fingerprinted image');
  const prepared = manifest.cronRecovery.apps.refresh;
  assert.equal(prepared.beforePause.paused, false);
  assert.equal(prepared.beforePause.nextAlarm, expectedAlarm, 'Snapshot must catch the selected native timer or retry');
  assert.ok(prepared.completedAt < expectedAlarm, 'Confirmed pause must precede the pending callback deadline');
  assert.equal(prepared.observation.paused, true); assert.equal(prepared.observation.nextAlarm, null);
  assert.ok(manifest.queueRecovery.apps.imports);
  await probe.save(`${selected}-snapshot`, { before, manifest });
  const shutdown = await retainAndDown(probe, directory, selected);
  return { directory, before, manifest, prepared, approvals: probe.approvals, shutdown };
}
export async function retainAndDown(probe, bundle, label) {
  assert.match(probe.project, /^fogd-m11c-cron-(?:recovery|retirement|activation|replacement|failures)-/);
  let failure, observed;
  if (probe.daemon) {
    try {
      for (const [name, surface] of Object.entries(probe.backgroundApps || { refresh: 'dispatch', imports: 'delivery' })) await probe.command(['admin', surface, name, 'pause']);
    } catch (error) { failure = error; }
  }
  await probe.compose(['stop', 'workerd', 'controller']);
  await probe.compose(['stop', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b']);
  await probe.compose(['stop', 'minio', 'bucket-init']);
  try { observed = await retainLogs(probe, label); assertShutdown(observed.exits); } catch (error) { failure ||= error; }
  await probe.compose(['down']); probe.daemon = false;
  const names = Object.values(probe.config.volumes).map(value => value.name);
  await stopped(probe.project, names); probe.closed = true;
  if (bundle) {
    const preservation = await compareSourceVolumes(probe, bundle);
    if (observed) observed.preservation = preservation;
  }
  probe.shutdown = observed;
  if (failure) throw failure;
  return observed;
}
async function retainLogs(probe, label) {
  const containers = await projectContainers(probe.project);
  const earliest = containers.map(value => value.State.StartedAt).filter(value => value && !value.startsWith('0001')).sort()[0];
  const logs = await probe.compose(['logs', '--no-color', ...(earliest ? ['--since', earliest] : [])]);
  await writeFile(join(dirname(probe.file), `${label}-runtime.log`), logs, { mode: 0o600 });
  assert.doesNotMatch(logs, /celld exited \(|SELF-FENCE|node_lease_watchdog_fence|panicked at|out of memory|Insufficient Storage|status(?: code)?[:= ]+507/i);
  return { earliest, exits: containers.map(value => ({ service: value.Config.Labels['com.docker.compose.service'], running: value.State.Running, code: value.State.ExitCode, restartCount: value.RestartCount, oomKilled: value.State.OOMKilled })) };
}
export async function armDueTimer(probe) {
  let control = await native(probe);
  await expect.poll(async () => {
    control = await native(probe);
    return !control.paused && control.nextAlarm - await vmNow(probe) > 25000;
  }, { timeout: 90000, intervals: [250, 500] }).toBe(true);
  return control;
}
