// Characterize native cron dispatch on a never-deployed disposable fleet.
// This bypasses fogd admission and does not qualify its activation lifecycle.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context, requireEmptyFleet, deploy } from './queue-probe/context.mjs';
import { expect } from './guestbook-browser.mjs';

const probe = await context(...process.argv.slice(2));
await requireEmptyFleet(probe);
const source = `export default {
  async fetch(request, env) {
    const listing = await env.RESULTS.list();
    const rows = await Promise.all(listing.objects.map(async object => (await env.RESULTS.get(object.key)).json()));
    return Response.json(rows.sort((a,b) => a.at - b.at));
  },
  async scheduled(controller, env) {
    const event = { id: crypto.randomUUID(), cron: controller.cron, scheduledTime: controller.scheduledTime, at: Date.now(), noRetry: typeof controller.noRetry };
    await env.RESULTS.put(event.id, JSON.stringify(event));
  }
};\n`;
async function publish(label, crons) {
  const directory = join(probe.output, label);
  await mkdir(directory);
  await writeFile(join(directory, 'index.js'), source);
  await writeFile(join(directory, 'wrangler.json'), JSON.stringify({ name: 'cron-probe', main: 'index.js', compatibility_date: '2026-01-01', no_bundle: true, triggers: { crons }, r2_buckets: [{ binding: 'RESULTS', bucket_name: 'cron-results' }] }));
  return deploy(probe, directory, label);
}
let published = false;
try {
  // Even a lost deploy response may have published a live schedule.
  published = true;
  const release = await publish('scheduled', ['* * * * *']);
  await expect.poll(async () => { try { return (await probe.app()).length; } catch { return 0; } }, { timeout: 150000, intervals: [1000, 3000] }).toBeGreaterThanOrEqual(2);
  const events = await probe.app(), state = await probe.state();
  assert.ok(events.every(event => event.cron === '* * * * *' && event.noRetry === 'function' && event.scheduledTime % 60000 === 0 && event.at >= event.scheduledTime));
  assert.equal(new Set(events.map(event => event.scheduledTime)).size, events.length, 'This unfaulted observation must not duplicate an occurrence');
  await probe.save('native', { release, events, state, scope: 'Unfaulted native timer dispatch only; direct runtime deployment bypasses fogd approval. No activation, retry, pause, recovery or exactly-once qualification.' });
  console.log('PASS: native scheduled handler records two minute occurrences without HTTP triggering');
} finally {
  if (published) {
    // Removing declarations does not prove an independent pause primitive.
    const release = await publish('unscheduled', []);
    await probe.save('cleanup', { release, state: await probe.state(), scope: 'Both replicas adopt a deployment with no cron declarations; volumes retained.' });
  }
}
