import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Integration checks of the same stdin program used in the observer container.
const program = readFileSync(new URL('../../../scripts/capacity/serving-observer.mjs', import.meta.url));
for (const [name, settings, message] of [
  ['write phase missing', { durationMs: 1000, concurrency: 1, maxDurationMs: 1000, workload: 'writes' }, 'Invalid serving workload profile'],
  ['unknown workload', { durationMs: 1000, concurrency: 1, maxDurationMs: 1000, workload: 'constructor' }, 'Invalid serving workload profile'],
  ['unbounded concurrency', { durationMs: 1000, concurrency: 100, maxDurationMs: 1000 }, 'Invalid serving workload'],
]) test(`standalone observer refuses ${name} before readiness or network work`, () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-', JSON.stringify(settings)], { input: program, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1); assert.equal(result.signal, null); assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(message));
});
