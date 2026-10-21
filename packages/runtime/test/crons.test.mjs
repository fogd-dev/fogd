import test from 'node:test';
import assert from 'node:assert/strict';
import { translateConfig } from '../src/artifact.mjs';
import { translateTriggers } from '../src/crons.mjs';

test('scheduled declarations require an explicit capability and preserve expression identity', () => {
  const input = { triggers: { crons: ['* * * * *', '*/3 * * * *'] } };
  assert.throws(() => translateConfig(input, 'refresh'), /Unsupported.*triggers/);
  assert.throws(() => translateConfig(input, 'refresh', { cronApps: 'true' }), /selected runtime/);
  const output = translateConfig(input, 'refresh', { cronApps: true });
  assert.deepEqual(output.triggers, input.triggers);
  assert.deepEqual(translateConfig(output, 'refresh', { cronApps: true }), output);
  input.triggers.crons[0] = '0 0 * * *';
  assert.equal(output.triggers.crons[0], '* * * * *');
  for (const triggers of [undefined, null, false, '', {}, { crons: null }, { crons: [] }]) assert.equal(translateTriggers(triggers, null), undefined);
});

test('scheduled declarations reject ambiguous or excessive input and combined queue activation', () => {
  for (const triggers of [[], { crons: 'every minute' }, { timezone: 'UTC', crons: ['* * * * *'] },
    { crons: [''] }, { crons: [' * * * * *'] }, { crons: ['* * * * *\n'] }, { crons: [1] },
    { crons: ['* * * * *', '* * * * *'] }, { crons: ['*\u00a0* * * *'] }, { crons: ['*\u2028* * * *'] }, { crons: ['x'.repeat(257)] },
    { crons: Array.from({ length: 17 }, (_, i) => `${i} * * * *`) }]) {
    assert.throws(() => translateTriggers(triggers, { cronApps: true }));
  }
  const queues = { producers: [{ binding: 'JOBS', queue: 'jobs' }], consumers: [{ queue: 'jobs', max_batch_size: 1, max_batch_timeout: 1, max_retries: 1, retry_delay: 1 }] };
  assert.throws(() => translateConfig({ queues, triggers: { crons: ['* * * * *'] } }, 'refresh', { cronApps: true }), /Combined cron and queue/);
});
