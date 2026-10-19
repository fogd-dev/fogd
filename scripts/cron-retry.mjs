// Negative control: kill the cron owner after observing its published retry deadline.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context, requireEmptyFleet, deploy } from './queue-probe/context.mjs';
import { expect } from './guestbook-browser.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
const probe = await context(...process.argv.slice(2));
await requireEmptyFleet(probe);
const cell = '.cron:cron-retry';
const source = `const instance=crypto.randomUUID();
export default {
  async fetch(request,env) {
    const listing=await env.RESULTS.list({prefix:'events/'});
    const events=await Promise.all(listing.objects.map(async o=>(await env.RESULTS.get(o.key)).json()));
    return Response.json({events,failedOnce:!!await env.RESULTS.get('failed-once')});
  },
  async scheduled(controller,env) {
    const event={instance,cron:controller.cron,scheduledTime:controller.scheduledTime,at:Date.now()};
    await env.RESULTS.put('events/'+crypto.randomUUID(),JSON.stringify(event));
    if(controller.cron==='* * * * *' && !await env.RESULTS.get('failed-once')) {
      await env.RESULTS.put('failed-once','yes');throw Error('intentional first occurrence failure');
    }
  }
};\n`;
async function publish(label,crons) {
  const directory=join(probe.output,label);await mkdir(directory);
  await writeFile(join(directory,'index.js'),source);
  await writeFile(join(directory,'wrangler.json'),JSON.stringify({name:'cron-retry',main:'index.js',compatibility_date:'2026-01-01',no_bundle:true,triggers:{crons},r2_buckets:[{binding:'RESULTS',bucket_name:'cron-retry-results'}]}));
  return deploy(probe,directory,label);
}
async function records() {
  return JSON.parse(await probe.node(`
    import {createRequire} from 'node:module';import {bucketClient} from './packages/runtime/src/bucket.mjs';
    const require=createRequire('/app/packages/platform/src/backend.mjs'),{GetObjectCommand,ListObjectsV2Command}=require('@aws-sdk/client-s3'),client=bucketClient(),Bucket=process.env.FOGD_BUCKET,prefix=${JSON.stringify(probe.slot.prefix)};
    const read=async Key=>JSON.parse(await(await client.send(new GetObjectCommand({Bucket,Key}))).Body.transformToString());
    const owner=await read(prefix+'/cells/${cell}/own.json');
    const listing=await client.send(new ListObjectsV2Command({Bucket,Prefix:prefix+'/wake/entries/'}));
    if(listing.IsTruncated)throw Error('Unexpected truncated wake listing');
    const wakes=(await Promise.all((listing.Contents||[]).map(async o=>({key:o.Key,...await read(o.Key)})))).filter(r=>r.cell===${JSON.stringify(cell)});
    console.log(JSON.stringify({owner,wakes,at:Date.now()}));
  `));
}
async function observe(host) {
  return JSON.parse(await probe.node(`const r=await fetch(${JSON.stringify(`http://${host}:8080/`)},{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('read failed '+r.status);console.log(await r.text());`));
}
let killed, evidence = {};
try {
  evidence.release=await publish('scheduled',['* * * * *','*/1 * * * *']);
  let first;
  await expect.poll(async()=>{first=await probe.app();return first.failedOnce&&first.events.length>=2;},{timeout:90000,intervals:[100,200]}).toBe(true);
  assert.equal(first.events.length,2,'Inconclusive: first retry window already passed');
  const initial=first.events.find(e=>e.cron==='* * * * *');
  assert.ok(first.events.every(e=>e.scheduledTime===initial.scheduledTime&&e.instance===initial.instance));
  assert.equal(initial.scheduledTime%60000,0);
  let before,deadline;
  await expect.poll(async()=>{before=await records();deadline=before.wakes.find(w=>w.due_ms>initial.scheduledTime&&w.due_ms<initial.scheduledTime+60000);return Boolean(deadline);},{timeout:3000,intervals:[50,100]}).toBe(true);
  const owner=before.owner.node;assert.ok(probe.slot.nodes.includes(owner));
  const survivor=probe.slot.nodes.find(n=>n!==owner);
  const state=JSON.parse(await probe.node(`console.log(await(await fetch(${JSON.stringify(`http://${owner}:8081/state`)})).text());`));
  assert.ok(state.residents.includes(cell));assert.equal(state.deployment.version,evidence.release.version);
  assert.ok(deadline.due_ms-before.at>=1000,'Inconclusive: too little retry window remains');
  evidence.before={first,bucket:before,deadline,owner,survivor,state};
  await probe.save('before-kill',evidence.before);
  killed=owner;await probe.compose(['kill','--signal','SIGKILL',owner]);
  const killAt=Number(await probe.node('console.log(Date.now())'));
  const container=(await probe.compose(['ps','-a','-q',owner])).trim();
  const [inspection]=JSON.parse(await execute('docker',['inspect',container]));
  assert.equal(inspection.State.Running,false);
  evidence.kill={at:killAt,container,exitCode:inspection.State.ExitCode};
  assert.ok(killAt<deadline.due_ms,'Inconclusive: kill missed retry deadline');
  let after;
  await expect.poll(async()=>{try{after=await observe(survivor);return after.events.some(e=>e.scheduledTime%60000!==0);}catch{return false;}},{timeout:120000,intervals:[500,1000]}).toBe(true);
  const moved=await records(),deployment=await probe.deployment(survivor);
  assert.equal(moved.owner.node,survivor);assert.ok(moved.owner.epoch>before.owner.epoch);
  assert.equal(deployment.version,evidence.release.version);
  const retry=after.events.filter(e=>e.scheduledTime===deadline.due_ms);
  assert.deepEqual(retry.map(e=>e.cron).sort(),['* * * * *','*/1 * * * *'].sort());
  assert.ok(retry.every(e=>e.instance!==initial.instance&&e.at>killAt));
  assert.equal(after.events.filter(e=>e.at<=killAt).length,2,'Inconclusive: retry ran before kill');
  evidence.after={...after,bucket:moved,deployment};
  evidence.scope='Negative control: published retry wake, SIGKILL before deadline, survivor ownership takeover on unchanged release. Retry deadline becomes scheduledTime and successful sibling reruns. Wake publication alone is not a general SQLite durability proof.';
  await probe.save('retry-identity',evidence);
  console.log('CONFIRMED: owner takeover changes retry scheduledTime and reruns the successful expression');
} catch(error) {
  await probe.save('failure',{error:error.message,evidence});throw error;
} finally {
  await writeFile(join(probe.output,'runtime.log'),await probe.compose(['logs','--no-color',...probe.slot.nodes]),{mode:0o600});
  if(killed)await probe.compose(['up','-d','--no-deps','--no-build','--pull','never',killed]);
  const release=await publish('unscheduled',[]);
  await probe.save('cleanup',{release,state:await probe.state()});
}
