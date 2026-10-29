import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recoveryTargetContext, loadRecoveryTarget, requireUnwritten } from './recovery-target.mjs';
import { expectedRetirementPolicy } from './retirement-policy.mjs';
import { expectRefusal, commandRefusal } from './evidence.mjs';
import { cleanupSelectedHost } from './host.mjs';
import { fingerprint } from '../../../packages/cli/src/recovery/bundle.mjs';
import { controllerState } from './observations.mjs';

export async function retirementTarget(source, point, active, surface, output, installations = [source]) {
  assert.ok(['delivery', 'dispatch'].includes(surface)); assert.deepEqual(point.approvals[active.app], active);
  assert.ok(point.retiredHistory && typeof point.retiredHistory === 'object');
  const queued = surface === 'delivery'; assert.ok(point.manifest[queued ? 'queueRecovery' : 'cronRecovery']?.apps[active.app]);
  const { target, destination, identity, networks, selector } = await recoveryTargetContext(source, point.bundle, output, installations);
  const durable = source.entry.routing === 'durable';
  const errors = durable
    ? { noSelector: /Durable restore is unconfirmed/, wrongIdentity: /Durable restore is unconfirmed/ }
    : { noSelector: /Installed runtime requires a matching independently checked runtime profile/, wrongIdentity: /Snapshot storage identity differs from the independently expected identity/ };
  const args = ['retire', point.bundle, '--app', active.app, '--digest', active.digest, '--project', target.project, '--output', destination, queued ? '--stop-queued-work' : '--stop-scheduled-work'];
  const invoke = selection => {
    const code = `import{retire}from ${JSON.stringify(new URL('../../../packages/cli/src/recovery/retire.mjs', import.meta.url).href)};await retire(${JSON.stringify(point.bundle)},${JSON.stringify(active.app)},${JSON.stringify(active.digest)},${JSON.stringify(target.project)},${JSON.stringify(destination)},${queued},${!queued},${JSON.stringify(selection)});`;
    return target.run(process.execPath, ['--input-type=module', '-e', code], { timeout: 300000 });
  };
  try {
    target.refusals.candidate = await expectRefusal(target, [...args, '--runtime', source.entry.id, '--expected-identity', identity], /candidate; ordinary enrollment remains closed/);
    await requireUnwritten(target, destination);
    target.refusals.noSelector = await expectRefusal(target, args, errors.noSelector);
    await requireUnwritten(target, destination);
    target.refusals.wrongIdentity = await commandRefusal(invoke({ ...selector, expectedIdentity: '0'.repeat(64) }), errors.wrongIdentity);
    await requireUnwritten(target, destination);
    await invoke(selector);
    const plan = JSON.parse(await readFile(join(destination, 'retirement.json')));
    const snapshot = await fingerprint(join(point.bundle, 'manifest.json'));
    assert.deepEqual(plan.snapshot, durable ? { sha256: snapshot.sha256 } : snapshot);
    const expected = expectedRetirementPolicy(source.policy, networks, active, plan, point.retiredHistory);
    await loadRecoveryTarget(source, target, destination, expected, point.manifest.images);
    if (durable) assert.equal((await controllerState(target)).apps[active.app].retirement.id, plan.id);
    else assert.equal(JSON.parse(await readFile(join(destination, 'restored.json'))).retirement, plan.id);
    target.retirement = plan; target.retiredApp = active.app;
    return target;
  } catch (error) {
    try { await cleanupSelectedHost(target); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Retirement target and cleanup failed'); }
    throw error;
  }
}
