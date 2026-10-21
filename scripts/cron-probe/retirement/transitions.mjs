import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installedClient } from '../recovery/client.mjs';
import { retainAndDown } from '../recovery/lifecycle.mjs';
import { appData } from './applications.mjs';
import { vmNow } from '../vm-time.mjs';

export async function snapshot(probe, directory, label, alarm = null) {
  const before = await appData(probe);
  for (const [name, tables] of Object.entries(before)) if (tables.cron_fault_attempts) assert.ok(!tables.cron_fault_attempts.some(row => row.outcome === 'pending'), `${name}: snapshot must start at a quiescent callback boundary`);
  if (alarm) assert.ok(alarm.due > await vmNow(probe));
  await probe.command(['backup', directory]); probe.daemon = false;
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  for (const [name, image] of Object.entries(manifest.images)) if (name !== 'minio') assert.equal(image, probe.identity.image);
  if (alarm) {
    const prepared = manifest.cronRecovery.apps[alarm.app];
    assert.equal(prepared.beforePause.paused, false); assert.equal(prepared.beforePause.nextAlarm, alarm.due);
    assert.ok(prepared.completedAt < alarm.due, 'Snapshot pause must finish before the selected timer or retry deadline');
    assert.equal(prepared.observation.paused, true); assert.equal(prepared.observation.nextAlarm, null);
  }
  const shutdown = await retainAndDown(probe, directory, label);
  return { directory, before, manifest, shutdown, alarm, approvals: structuredClone(probe.approvals) };
}
export async function retirement(source, point, name, directory, suffix) {
  const active = source.approvals[name], surface = source.backgroundApps[name];
  if (surface === 'delivery') assert.ok(point.manifest.queueRecovery.apps[name].observation.backlogCount >= 1, 'Queue retirement must retain real pending work');
  const flag = surface === 'dispatch' ? '--stop-scheduled-work' : '--stop-queued-work';
  const target = await installedClient(source, ['retire', point.directory, '--app', name, '--digest', active.digest, flag], `${source.project}-${suffix}`, directory);
  try {
    const plan = JSON.parse(await readFile(join(directory, 'retirement.json'), 'utf8'));
    assert.equal(plan.app, name); assert.equal(plan.digest, active.digest);
    assert.notEqual(plan.previous.prefix, plan.replacement.prefix);
    assert.ok(plan.replacement.nodes.every(node => !plan.previous.nodes.includes(node)));
    for (const service of Object.keys(source.config.volumes)) assert.notEqual(target.config.volumes[service].name, source.config.volumes[service].name);
    return { target, plan };
  } catch (error) {
    try { await retainAndDown(target, null, 'retirement-validation-failure'); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `Retirement validation and cleanup failed for ${target.project}`, { cause: error }); }
    throw error;
  }
}
