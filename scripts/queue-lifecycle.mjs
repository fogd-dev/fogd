import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { consumer, context, publish, requireEmptyFleet } from './queue-probe/context.mjs';
import { expect } from './guestbook-browser.mjs';

const probe = await context(...process.argv.slice(2));
await requireEmptyFleet(probe);
await publish(probe, 'bootstrap', true);
assert.equal((await probe.queue('pause')).paused, true);
await publish(probe, 'v1');
await probe.app({ id: 'paused' });
await setTimeout(3000);
assert.deepEqual(await probe.app(), []);
assert.equal((await probe.queue('info')).backlogCount, 1);
await probe.queue('resume');
await event('paused', 'completed');
await probe.save('first-publication', { events: await probe.app(), queue: await probe.queue('info') });
console.log('PASS: bootstrap pause gates first consumer publication');

await probe.app({ id: 'held', holdMs: probe.budget * 600 });
await event('held', 'started');
await probe.queue('pause');
await probe.app({ id: 'pending' });
const v2 = await publish(probe, 'v2');
const paused = await probe.queue('info');
const beforeResume = { events: await probe.app(), state: await probe.state(), queue: paused, v2 };
const residents = beforeResume.state.flatMap(node => Object.entries(node.deployment.cells).filter(([cell]) => cell.startsWith('__Queue:')).map(([, generation]) => ({ generation, current: node.deployment.generation, version: node.deployment.version })));
assert.equal(residents.length, 1);
assert.equal(residents[0].generation, residents[0].current);
assert.equal(residents[0].version, v2.version);
await probe.save('held-before-resume', beforeResume);
assert.equal(beforeResume.queue.paused, true);
assert.ok(!beforeResume.events.some(e => e.job === 'held' && e.stage === 'completed'), 'Held handler must still be in flight at publication');
await probe.queue('resume');
await event('held', 'completed'); await event('pending', 'completed');
const updated = await probe.app();
await probe.save('held-after-resume', { events: updated, state: await probe.state(), queue: await probe.queue('info') });
assert.equal(updated.find(e => e.job === 'held' && e.stage === 'completed').version, 'v1');
assert.equal(updated.find(e => e.job === 'pending' && e.stage === 'completed').version, 'v2');
assert.ok(updated.find(e => e.job === 'pending' && e.stage === 'completed').at < updated.find(e => e.job === 'held' && e.stage === 'completed').at, 'New consumer must finish while the old handler is still running');
console.log('PASS: current-generation queue dispatch overlaps a held v1 handler with v2 pending work');

await probe.app({ id: 'wait-until', waitUntilMs: 8000 });
await event('wait-until', 'completed');
await probe.queue('pause');
const waitingQueue = await probe.queue('info'), waitingEvents = await probe.app();
assert.equal(waitingQueue.stored, 0); assert.equal(waitingQueue.paused, true);
assert.ok(!waitingEvents.some(e => e.job === 'wait-until' && e.stage === 'wait-until'));
await probe.save('wait-until-before', { events: waitingEvents, queue: waitingQueue, state: await probe.state() });
await event('wait-until', 'wait-until');
await probe.save('wait-until-after', { events: await probe.app(), queue: await probe.queue('info') });
await probe.queue('resume');
console.log('PASS: waitUntil produces an effect after a paused queue reports no stored messages');

await probe.app({ id: 'wait-until-long', waitUntilMs: (probe.budget + 15) * 1000 });
await event('wait-until-long', 'completed');
await probe.queue('pause');
await event('wait-until-long', 'wait-until');
await probe.save('wait-until-beyond-budget', { events: await probe.app(), queue: await probe.queue('info') });
await probe.queue('resume');
console.log('PASS: waitUntil outlives the configured handler response budget');

await probe.app({ id: 'poison', fail: true });
const attempts = consumer.max_retries + 1;
await event('poison', 'failed', attempts);
await emptyQueue();
await setTimeout((consumer.retry_delay + 2) * 1000);
const poisonEvents = await probe.app();
assert.equal(poisonEvents.filter(e => e.job === 'poison' && e.stage === 'started').length, attempts);
assert.equal((await probe.queue('info')).stored, 0);
await probe.save('exhaustion', { events: poisonEvents, queue: await probe.queue('info') });
console.log('PASS: handled poison job exhausts two attempts without a DLQ');

const holdMs = (probe.budget + 7) * 1000;
await probe.app({ id: 'over-budget', holdMs });
await event('over-budget', 'started', attempts, 180000);
await emptyQueue(180000);
const lastStart = (await probe.app()).find(e => e.job === 'over-budget' && e.stage === 'started' && e.attempt === attempts).at;
const observationAfter = lastStart + holdMs + 5000;
await setTimeout(Math.max(0, observationAfter - Number(await probe.node('console.log(Date.now())'))));
const observedAt = Number(await probe.node('console.log(Date.now())'));
assert.ok(observedAt >= observationAfter);
const timed = { observationAfter, observedAt, events: await probe.app(), queue: await probe.queue('info'), state: await probe.state() };
await probe.save('over-budget', timed);
assert.ok(!timed.events.some(e => e.job === 'over-budget' && e.stage === 'completed'), 'Timed-out handler produced a late effect');
await probe.queue('pause');
console.log('PASS: over-budget attempts exhausted without a late completion marker; fleet left paused');

async function event(job, stage, attempt = 1, timeout = 120000) {
  await expect.poll(async () => { try { return (await probe.app()).some(e => e.job === job && e.stage === stage && e.attempt === attempt); } catch { return false; } }, { timeout }).toBe(true);
}
async function emptyQueue(timeout = 120000) {
  await expect.poll(async () => { try { return (await probe.queue('info')).stored; } catch { return -1; } }, { timeout }).toBe(0);
}
