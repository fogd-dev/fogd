// The first qualified profile: one producer and consumer with bounded delivery.
const policy = ['max_batch_size', 'max_batch_timeout', 'max_retries', 'retry_delay'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function fields(value, allowed) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported queue configuration fields');
}
export function validateQueueDeclaration(queues) {
  fields(queues, ['producers', 'consumers']);
  if (!Array.isArray(queues.producers) || !Array.isArray(queues.consumers) || queues.producers.length !== 1 || queues.consumers.length !== 1) throw new Error('Queues require one same-app producer and consumer');
  const producer = queues.producers[0], consumer = queues.consumers[0];
  fields(producer, ['binding', 'queue']); fields(consumer, ['queue', ...policy]);
  if (typeof producer.binding !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(producer.binding)) throw new Error('Invalid queue binding identifier');
  if (typeof producer.queue !== 'string' || !namePattern.test(producer.queue) || producer.queue !== consumer.queue) throw new Error('Queue names must match and use 1–63 lowercase letters, digits, or internal hyphens');
  if (policy.some(key => consumer[key] !== 1)) throw new Error(`Qualified queue policy requires ${policy.join(', ')} all set to integer 1`);
  return producer.queue;
}
export function translateQueues(input, app) {
  if (input === undefined || input === null) return undefined;
  fields(input, ['producers', 'consumers']);
  if (Object.values(input).every(value => Array.isArray(value) && value.length === 0)) return undefined;
  const logical = validateQueueDeclaration(input);
  const queue = logical.startsWith(`${app}-`) ? logical : `${app}-${logical}`;
  if (!namePattern.test(queue)) throw new Error('Derived queue name exceeds 63 characters; shorten the app or queue name');
  return { producers: [{ binding: input.producers[0].binding, queue }], consumers: [{ queue, ...Object.fromEntries(policy.map(key => [key, 1])) }] };
}
