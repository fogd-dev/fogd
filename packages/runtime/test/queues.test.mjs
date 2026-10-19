import test from 'node:test';
import assert from 'node:assert/strict';
import { translateQueues, validateQueueDeclaration } from '../src/queues.mjs';
const declaration = queue => ({ producers: [{ binding: 'JOBS', queue }], consumers: [{ queue, max_batch_size: 1, max_batch_timeout: 1, max_retries: 1, retry_delay: 1 }] });
test('queue translation preserves logical dispatch suffixes and is canonical on receipt', () => {
  const first = translateQueues(declaration('jobs'), 'demo');
  assert.equal(first.producers[0].queue, 'demo-jobs');
  assert.deepEqual(translateQueues(first, 'demo'), first);
  assert.deepEqual(translateQueues(declaration('demo-jobs'), 'demo'), first);
  for (const input of [undefined, null, {}, { producers: [], consumers: [] }]) assert.equal(translateQueues(input, 'demo'), undefined);
});
test('queue profile refuses unqualified policies, shapes, names and options', () => {
  for (const input of [false, [], { producers: [{}] }, { producers: [], consumers: [{ queue: 'jobs' }] }]) assert.throws(() => translateQueues(input, 'demo'));
  for (const key of ['max_batch_size', 'max_batch_timeout', 'max_retries', 'retry_delay']) {
    for (const value of [undefined, null, '1', true, 0, 2, 1.5]) {
      const input = declaration('jobs'); input.consumers[0][key] = value;
      assert.throws(() => validateQueueDeclaration(input), /integer 1/);
    }
  }
  for (const key of ['dead_letter_queue', 'max_concurrency', 'script_name']) {
    const input = declaration('jobs'); input.consumers[0][key] = 'other';
    assert.throws(() => validateQueueDeclaration(input), /Unsupported/);
  }
  const delayed = declaration('jobs'); delayed.producers[0].delivery_delay = 1;
  assert.throws(() => validateQueueDeclaration(delayed), /Unsupported/);
  const foreign = declaration('jobs'); foreign.consumers[0].queue = 'other';
  assert.throws(() => validateQueueDeclaration(foreign), /match/);
  for (const name of ['Jobs', '-jobs', 'jobs-', 'a'.repeat(64), 'jobs/other']) assert.throws(() => validateQueueDeclaration(declaration(name)), /names/);
  assert.throws(() => translateQueues(declaration('jobs'), 'a'.repeat(60)), /63 characters/);
});
