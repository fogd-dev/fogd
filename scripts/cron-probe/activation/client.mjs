import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { composeArgs } from '../../../packages/cli/src/recovery/docker.mjs';

export function activationClient(fixture) {
  const { config, output, selected, profile } = fixture;
  const env = { ...process.env, ...selected, FOGD_ENV_FILE: join(output, 'absent.env') };
  const slots = JSON.parse(config.services.controller.environment.FOGD_SLOTS), slot = slots[0];
  const compose = (args, options = {}) => execute('docker', [...composeArgs(selected.FOGD_COMPOSE_FILE, config.name), ...args], { env, ...options });
  const node = code => compose(['exec', '-T', 'controller', '/usr/local/bin/node', '--input-type=module', '-e', code]);
  const raw = (args, target) => compose(['exec', '-T', '-e', `CELLD_BUCKET=s3://${profile.bucket}/${target.prefix}`, 'controller', '/usr/local/bin/celld', ...args]);
  const comparisons = [];
  async function control(operation) {
    const method = operation === 'info' ? 'status' : 'pause';
    const timed = JSON.parse(await node(`import{guardedBackend}from'/app/qualification/backend.mjs';const startedAt=Date.now(),backend=await guardedBackend();try{const result=await backend.crons.${method}(${JSON.stringify(slot)},'refresh');console.log(JSON.stringify({result,startedAt,completedAt:Date.now()}))}finally{backend.s3.destroy()}`));
    const result = timed.result, direct = JSON.parse(await raw(['cron', 'info', 'refresh', '--json'], slot));
    if (result.paused) assert.deepEqual(result, direct, 'Guarded and direct held cron status differ');
    comparisons.push({ operation, guarded: result, direct, startedAt: timed.startedAt, durationMs: timed.completedAt - timed.startedAt });
    return JSON.stringify(result);
  }
  return { output, file: selected.FOGD_COMPOSE_FILE, project: config.name, env, config, slot, slots, compose, node, runtimeProfile: profile, daemon: false, cronComparisons: comparisons,
    async cli(args, target = slot) {
      assert.deepEqual(target, slot);
      if (args[0] === 'cron') { assert.deepEqual(args, ['cron', 'info', 'refresh', '--json']); return control('info'); }
      assert.deepEqual(args.slice(0, 4), ['d1', 'execute', 'refresh-db', '--command']);
      assert.equal(args.length, 7); assert.equal(args[6], '--json');
      assert.match(args[4], /^SELECT [a-z_,]+ FROM refresh_(occurrences|results) ORDER BY [a-z_,]+;$/);
      assert.match(args[5], /^\/var\/lib\/fogd\/artifacts\/[a-f0-9-]{36}$/);
      return raw(args, slot);
    },
    cleanupPause: () => control('pause'),
    save: (name, value) => writeFile(join(output, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }),
  };
}
