// Characterize celld cron behavior after an uncatchable handler timeout.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context, requireEmptyFleet, deploy } from './queue-probe/context.mjs';
import { expect } from './guestbook-browser.mjs';
import { cleanupCronProbe } from './cron-probe-cleanup.mjs';

const probe = await context(process.argv[2], process.argv[3]);
await requireEmptyFleet(probe);
const operationDeadlineMs = Number(probe.config.services[probe.slot.nodes[0]].environment.CELLD_OPERATION_DEADLINE_MS || 15000);
assert.ok(operationDeadlineMs > probe.budget * 1000, 'Set the operation deadline above the handler budget to isolate handler termination');
assert.ok(probe.slot.nodes.every(host => Number(probe.config.services[host].environment.CELLD_OPERATION_DEADLINE_MS || 15000) === operationDeadlineMs));
const cell = '.cron:cron-timeout';
const source = `export default {
  async fetch(request, env) {
    const listing = await env.RESULTS.list({prefix:'events/'});
    const events = await Promise.all(listing.objects.map(async object => (await env.RESULTS.get(object.key)).json()));
    return Response.json(events);
  },
  async scheduled(controller, env) {
    const event = {cron:controller.cron, scheduledTime:controller.scheduledTime, at:Date.now()};
    await env.RESULTS.put('events/'+crypto.randomUUID(), JSON.stringify(event));
    await new Promise(() => {});
  }
};\n`;
async function publish(label, crons) {
  const directory = join(probe.output, label);
  await mkdir(directory, {recursive:true});
  await writeFile(join(directory, 'index.js'), source);
  await writeFile(join(directory, 'wrangler.json'), JSON.stringify({name:'cron-timeout', main:'index.js', compatibility_date:'2026-01-01', no_bundle:true, triggers:{crons}, r2_buckets:[{binding:'RESULTS',bucket_name:'cron-timeout-results'}]}));
  return deploy(probe, directory, label);
}
async function events() { return (await probe.app()).sort((a, b) => a.at - b.at); }
async function wakes() {
  const code = `import {createRequire} from 'node:module';import {bucketClient} from './packages/runtime/src/bucket.mjs';const require=createRequire('/app/packages/platform/src/backend.mjs'),{GetObjectCommand,ListObjectsV2Command}=require('@aws-sdk/client-s3'),client=bucketClient(),Bucket=process.env.FOGD_BUCKET,prefix=${JSON.stringify(probe.slot.prefix)};const listing=await client.send(new ListObjectsV2Command({Bucket,Prefix:prefix+'/wake/entries/'}));const rows=await Promise.all((listing.Contents||[]).map(async o=>({key:o.Key,...await (async()=>{try{return JSON.parse(await(await client.send(new GetObjectCommand({Bucket,Key:o.Key}))).Body.transformToString());}catch(error){if(error.$metadata?.httpStatusCode===404)return {};throw error;}})()})));console.log(JSON.stringify(rows.filter(row=>row.cell===${JSON.stringify(cell)})));`;
  return JSON.parse(await probe.node(code));
}
let publicationAttempted = false, failure, stage = 'publish';
try {
  publicationAttempted = true;
  const release = await publish('scheduled', ['* * * * *']);
  stage = 'first invocation';
  let rows;
  await expect.poll(async()=>{try{rows=await events();return rows.length>0;}catch{return false;}},{timeout:150000,intervals:[250,500,1000]}).toBe(true);
  const firstScheduled = rows[0].scheduledTime;
  assert.equal(firstScheduled % 60000, 0);
  stage = 'terminal wake observation';
  let nextWake;
  await expect.poll(async () => {
    nextWake = (await wakes()).filter(row => row.due_ms > firstScheduled && row.due_ms % 60000 === 0);
    return nextWake.length;
  }, {timeout:(6 * probe.budget + 126 + 60) * 1000, intervals:[500,1000]}).toBeGreaterThan(0);
  assert.ok(nextWake.every(row => row.due_ms > Date.now()), 'Advancement must arm a future occurrence');
  const advancedAt = Date.now();
  stage = 'next occurrence dispatch';
  // Observe the saved wake actually dispatching before counting the terminal set.
  await expect.poll(async () => {
    rows = await events();
    return rows.some(row => nextWake.some(wake => row.scheduledTime === wake.due_ms));
  }, {timeout:90000, intervals:[500,1000]}).toBe(true);
  stage = 'terminal attempt assertions';
  const attempts = rows.filter(row => row.scheduledTime === firstScheduled);
  await probe.save('terminal-observation', {firstScheduled, attempts, nextWake, advancedAt, events:rows});
  assert.equal(attempts.length, 6, 'Expected callbacks at native retryCount 0 through 5; count 6 advances without invoking');
  assert.ok(attempts.every(row => row.cron === '* * * * *'));
  const runtimeLog = await probe.compose(['logs', '--no-color']);
  assert.doesNotMatch(runtimeLog, /SELF-FENCE|node_lease_watchdog_fence|panicked at|out of memory/i, 'Runtime failure invalidates timeout isolation');
  const state = await probe.state();
  await probe.save('timeout', {release, firstScheduled, attempts, nextWake, advancedAt, events:rows, state,
    handlerBudgetSeconds:probe.budget, operationDeadlineMs,
    scope:'Disposable runtime only. Unresolved-promise termination and native alarm retries are bounded for one armed alarm. The configured operation deadline exceeds the handler budget for this run. This does not qualify CPU limits or arbitrary application retries.'});
  console.log('PASS: native handler timeouts are bounded and the cron alarm advances');
} catch (error) {
  failure = error;
  await probe.save('failure', {stage, message:error.message});
  throw error;
} finally {
  try {
    await cleanupCronProbe(probe, async () => {
      if (publicationAttempted) {
        const release = await publish('unscheduled', []);
        await probe.save('cleanup', {release, state:await probe.state()});
      }
    });
  } catch (error) {
    if (!failure) throw error;
    console.error('Cleanup failed; stop the disposable fleet and inspect its private evidence');
  }
}
