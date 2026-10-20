// Qualify the experimental native hold on a never-deployed disposable fleet.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context, requireEmptyFleet, deploy } from './queue-probe/context.mjs';
import { expect } from './guestbook-browser.mjs';
import { cleanupCronProbe } from './cron-probe-cleanup.mjs';

const probe = await context(process.argv[2], process.argv[3]);
await requireEmptyFleet(probe);
const script = 'cron-controls';
const source = `export default {
  async fetch(request, env) {
    if(request.method==='POST') { await env.RESULTS.put('release','yes'); return Response.json({released:true}); }
    const listing=await env.RESULTS.list({prefix:'events/'});
    const rows=await Promise.all(listing.objects.map(async o=>(await env.RESULTS.get(o.key)).json()));
    return Response.json(rows.sort((a,b)=>a.at-b.at));
  },
  async scheduled(controller, env) {
    const save=phase=>env.RESULTS.put('events/'+crypto.randomUUID(),JSON.stringify({cron:controller.cron,scheduledTime:controller.scheduledTime,at:Date.now(),phase}));
    await save('started');
    if(controller.cron==='* * * * *') while(!(await env.RESULTS.get('release'))) await new Promise(r=>setTimeout(r,100));
    await save('finished');
  }
};\n`;
async function publish(label, crons) {
  const dir = join(probe.output, label); await mkdir(dir);
  await writeFile(join(dir, 'index.js'), label === 'bootstrap' ? "export default {fetch(){return new Response('Bootstrap',{status:503})}};\n" : source);
  await writeFile(join(dir, 'wrangler.json'), JSON.stringify({name:script, main:'index.js', no_bundle:true,
    compatibility_date:'2026-01-01', triggers:{crons}, r2_buckets:[{binding:'RESULTS',bucket_name:'cron-control-results'}]}));
  return deploy(probe, dir, label);
}
async function control(op) {
  return JSON.parse((await probe.cli(['cron', op, script, '--json'])).trim());
}
async function throughBoundary() {
  const boundary = Math.floor(Date.now() / 60000 + 1) * 60000;
  await expect.poll(() => Date.now(), {timeout:70000, intervals:[500,1000]}).toBeGreaterThan(boundary + 1500);
  return boundary;
}
let publicationAttempted = false, failure, stage = 'bootstrap';
try {
  publicationAttempted = true;
  const bootstrap = await publish('bootstrap', []);
  const initial = await control('info');
  assert.equal(initial.paused, true); assert.equal(initial.nextAlarm, null);
  stage = 'unsigned internal transport';
  const unsignedAccess = [];
  for (const path of [`/do/.cron:${script}`, `/runtime/.cron:${script}`]) {
    const url = `http://${probe.slot.nodes[0]}:8081${path}`;
    const response = JSON.parse(await probe.node(`const r=await fetch(${JSON.stringify(url)},{method:'POST',body:JSON.stringify({op:'resume'})});console.log(JSON.stringify({status:r.status,body:await r.text()}));`));
    unsignedAccess.push({path, ...response});
    assert.equal(response.status, path.startsWith('/do/') ? 403 : 401, 'Unsigned cron access must be refused');
  }
  stage = 'adoption hold';
  const scheduled = await publish('scheduled', ['* * * * *', '*/1 * * * *']);
  const heldBoundary = await throughBoundary();
  assert.deepEqual(await probe.app(), []);
  stage = 'held callback pause';
  const resumedAt = Date.now(), resumed = await control('resume');
  assert.equal(resumed.paused, false); assert.ok(resumed.nextAlarm > resumedAt);
  let started;
  await expect.poll(async () => { started = await probe.app(); return started.length; }, {timeout:80000, intervals:[250,500]}).toBe(1);
  const paused = await control('pause');
  assert.equal(paused.paused, true); assert.equal(paused.nextAlarm, null);
  assert.equal(paused.revision, resumed.revision + 1);
  await probe.app({release:true});
  let finished;
  await expect.poll(async () => { finished = await probe.app(); return finished.length; }, {timeout:10000, intervals:[100,250]}).toBe(2);
  assert.deepEqual(finished.map(row => row.phase), ['started','finished']);
  assert.ok(finished.every(row => row.cron === '* * * * *'));
  // All replicas restart; a newly loaded object must retain the dispatch hold.
  stage = 'restart hold';
  await probe.compose(['restart', ...probe.slot.nodes]);
  await expect.poll(async () => { try { return (await control('info')).paused; } catch { return false; } }, {timeout:90000}).toBe(true);
  const restartBoundary = await throughBoundary();
  assert.deepEqual(await probe.app(), finished);
  const restartStatus = await control('info');
  assert.equal(restartStatus.nextAlarm, null);
  assert.equal(restartStatus.revision, paused.revision, 'Restart must retain the recorded hold, not merely default to held');
  stage = 'explicit resume';
  const explicitResumeAt = Date.now(), explicitResume = await control('resume');
  assert.ok(explicitResume.nextAlarm > explicitResumeAt);
  assert.equal(explicitResume.revision, paused.revision + 1);
  let afterResume;
  await expect.poll(async () => { afterResume = await probe.app(); return afterResume.length; }, {timeout:80000, intervals:[250,500]}).toBe(6);
  assert.ok(afterResume.slice(2).every(row => row.scheduledTime === explicitResume.nextAlarm));
  assert.deepEqual(afterResume.slice(2).map(row => `${row.cron}:${row.phase}`).sort(),
    ['* * * * *:started','* * * * *:finished','*/1 * * * *:started','*/1 * * * *:finished'].sort());
  const finalPause = await control('pause');
  assert.equal(finalPause.paused, true); assert.equal(finalPause.nextAlarm, null);
  assert.equal(finalPause.revision, explicitResume.revision + 1);
  const log = await probe.compose(['logs','--no-color']);
  assert.doesNotMatch(log, /SELF-FENCE|node_lease_watchdog_fence|panicked at|out of memory/i);
  await probe.save('controls', {bootstrap, scheduled, initial, unsignedAccess, heldBoundary, resumedAt, resumed, started, paused,
    finished, restartBoundary, restartStatus, explicitResumeAt, explicitResume, afterResume, finalPause,
    state:await probe.state(), scope:'Native primitive only. Hold survives adoption and full replica restart; an in-flight callback finishes while its sibling and rearm are suppressed. Platform activation and snapshot recovery remain unqualified.'});
  console.log('PASS: native cron controls retain a dispatch hold across adoption and restart');
} catch (error) {
  failure = error;
  await probe.save('failure', {stage, message:error.message});
  throw error;
} finally {
  try {
    await cleanupCronProbe(probe, async () => {
      if (publicationAttempted) {
        // A lost publication reply can follow a successful write.
        try { await control('pause'); }
        finally { await publish('unscheduled', []); }
      }
    });
  } catch (error) {
    if (!failure) throw error;
    console.error('Cleanup failed; stop the disposable fleet and inspect its private evidence');
  }
}
