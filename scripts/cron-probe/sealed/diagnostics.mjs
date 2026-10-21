import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export function guardCronDiagnostics(probe, scripts = ['refresh']) {
  const raw = probe.cli; probe.cronComparisons = [];
  probe.cli = async (args, slot = probe.slot) => {
    if (args[0] !== 'cron') return raw(args, slot);
    assert.equal(args.length, 4); assert.equal(args[1], 'info'); assert.equal(args[3], '--json');
    assert.ok(scripts.includes(args[2]), 'Only known cron status is a diagnostic command');
    assert.ok(probe.slots.some(value => isDeepStrictEqual(value, slot)));
    const code = `import{guardedBackend}from'/app/qualification/backend.mjs';const backend=await guardedBackend();try{console.log(JSON.stringify(await backend.crons.status(${JSON.stringify(slot)},${JSON.stringify(args[2])})))}finally{backend.s3.destroy()}`;
    const value = await probe.compose(probe.daemon ? ['exec', '-T', 'controller', '/usr/local/bin/node', '--input-type=module', '-e', code]
      : ['run', '--rm', '--no-deps', '--entrypoint', '/usr/local/bin/node', 'controller', '--input-type=module', '-e', code]);
    const guarded = JSON.parse(value), direct = JSON.parse(await raw(args, slot));
    if (guarded.paused) assert.deepEqual(guarded, direct, 'Guarded and direct held cron status differ');
    probe.cronComparisons.push({ script: args[2], slot: slot.id, guarded, direct, held: guarded.paused });
    return value;
  };
}
