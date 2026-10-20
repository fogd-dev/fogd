import assert from 'node:assert/strict';
import { mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { context, requireEmptyFleet, upload } from './queue-probe/context.mjs';
import { cleanupCronProbe } from './cron-probe-cleanup.mjs';

const probe = await context(process.argv[2], process.argv[3]);
await requireEmptyFleet(probe);
let failure;
try {
  const runner = join(probe.output, 'runner'); await mkdir(runner);
  await cp(new URL('./cron-probe/controller.mjs', import.meta.url), join(runner, 'controller.mjs'));
  const remote = await upload(probe, runner, 'cron-controller-runner');
  const result = JSON.parse((await probe.compose(['exec', '-T', 'controller', 'node', `${remote}/controller.mjs`, probe.slot.id])).trim());
  assert.equal(result.dispatch.desired, 'paused'); assert.equal(result.dispatch.hold, null);
  assert.ok(result.firstRows.length); assert.deepEqual(result.finalRows, result.firstRows);
  await probe.save('controller', result);
  console.log('PASS: native cron controller bootstrap, delayed migration, lost resume recovery and paused update');
} catch (error) {
  failure = error; await probe.save('failure', { message: error.message }); throw error;
} finally {
  try { await cleanupCronProbe(probe, () => probe.cli(['cron', 'pause', 'refresh', '--json'])); }
  catch (error) { if (!failure) throw error; console.error('Cleanup failed; stop the disposable fleet and retain its private evidence'); }
}
