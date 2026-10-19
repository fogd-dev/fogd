import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { expect } from '../guestbook-browser.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configEnv, stackRoot } from '../../packages/cli/src/local.mjs';
import { resolvedCompose } from '../../packages/cli/src/compose/config.mjs';
import { composeArgs } from '../../packages/cli/src/recovery/docker.mjs';
import { execute } from '../../packages/cli/src/recovery/execute.mjs';

export const consumer = Object.freeze({ queue: 'probe-jobs', max_batch_size: 1, max_batch_timeout: 1, max_retries: 1, retry_delay: 1 });

export async function context(slotId, outputArg, { env: selectedEnv = null, queueName = 'probe-jobs' } = {}) {
  assert.match(slotId || '', /^slot-[12]$/);
  assert.ok(outputArg, 'Supply a new evidence directory');
  const env = selectedEnv || await configEnv(), config = await resolvedCompose(env), output = resolve(outputArg);
  assert.match(config.name, /^fogd-m11[a-z0-9-]*$/);
  const slots = JSON.parse(config.services.controller.environment.FOGD_SLOTS);
  const slot = slots.find(s => s.id === slotId);
  assert.ok(slot);
  const budget = Number(config.services[`${slotId}-a`].environment.CELLD_HANDLER_BUDGET_S);
  assert.ok(Number.isInteger(budget) && budget >= 15 && budget <= 30, 'Probe replicas require a 15–30 second handler budget');
  assert.equal(Number(config.services[`${slotId}-b`].environment.CELLD_HANDLER_BUDGET_S), budget);
  await mkdir(output, { mode: 0o700 });
  const file = env.FOGD_COMPOSE_FILE || join(stackRoot, 'compose.yaml');
  const compose = args => execute('docker', [...composeArgs(file, config.name), ...args], { env });
  const node = code => compose(['exec', '-T', 'controller', 'node', '--input-type=module', '-e', code]);
  const cli = (args, selected = slot) => compose(['exec', '-T', '-e', `CELLD_BUCKET=s3://${config.services.controller.environment.FOGD_BUCKET}/${selected.prefix}`, 'controller', 'celld', ...args]);
  const queue = (verb, selected = slot) => queueCommand(cli, verb, selected, queueName);
  const http = async (path, options = {}) => JSON.parse(await node(`const r=await fetch(${JSON.stringify(`http://${slot.nodes[0]}:8080`)}+${JSON.stringify(path)},${JSON.stringify(options)});console.log(JSON.stringify({status:r.status,body:await r.text()}));`));
  const app = async body => { const response = await http('/', body ? { method: 'POST', body: JSON.stringify(body) } : {}); assert.equal(response.status, 200); return JSON.parse(response.body); };
  const deployment = async host => JSON.parse(await node(`const r=await fetch(${JSON.stringify(`http://${host}:8081/state`)},{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('state');console.log(JSON.stringify((await r.json()).deployment));`));
  const state = async () => Promise.all(slot.nodes.map(async host => ({ host, deployment: await deployment(host) })));
  const save = async (name, value) => writeFile(join(output, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await save('context', { project: config.name, slot: slot.id, handlerBudgetSeconds: budget, images: Object.fromEntries(slot.nodes.map(host => [host, config.services[host].image])) });
  return { env, config, slot, slots, output, budget, compose, node, cli, queue, http, app, deployment, state, save };
}
export async function requireEmptyFleet(probe) {
  const code = `import {createRequire} from 'node:module';import {bucketClient} from './packages/runtime/src/bucket.mjs';const require=createRequire('/app/packages/platform/src/backend.mjs');const {ListObjectsV2Command}=require('@aws-sdk/client-s3');const r=await bucketClient().send(new ListObjectsV2Command({Bucket:process.env.FOGD_BUCKET,Prefix:${JSON.stringify(`${probe.slot.prefix}/deploy/`)},MaxKeys:1}));console.log(r.KeyCount||0);`;
  assert.equal(Number(await probe.node(code)), 0, 'Probe requires a never-deployed fleet');
}
export async function publish(probe, version, bootstrap = false) {
  const dir = join(probe.output, version); await mkdir(dir, { mode: 0o700 });
  const source = bootstrap ? "export default {fetch(){return new Response('Bootstrap',{status:503})}};" : (await readFile(join(stackRoot, 'scripts/queue-probe/worker.mjs'), 'utf8')).replace('PROBE_VERSION', version);
  const config = { name: 'queue-probe', main: 'index.js', compatibility_date: '2026-01-01', no_bundle: true, queues: { producers: [{ binding: 'JOBS', queue: 'probe-jobs' }], ...(bootstrap ? {} : { consumers: [consumer] }) }, ...(bootstrap ? {} : { r2_buckets: [{ binding: 'RESULTS', bucket_name: 'probe-results' }] }) };
  await writeFile(join(dir, 'index.js'), source); await writeFile(join(dir, 'wrangler.json'), JSON.stringify(config));
  return deploy(probe, dir, version);
}
export async function upload(probe, directory, label) {
  assert.match(label, /^[a-z0-9-]+$/);
  const target = `/tmp/fogd-queue-probe-${probe.slot.id}-${label}-${randomUUID()}`;
  await probe.compose(['exec', '-T', 'controller', 'mkdir', '-p', target]);
  await probe.compose(['cp', `${directory}/.`, `controller:${target}`]);
  return target;
}
export async function deploy(probe, directory, label) {
  const target = await upload(probe, directory, label);
  const deployed = JSON.parse((await probe.cli(['deploy', target, '--json'])).trim().split('\n').at(-1));
  for (const host of probe.slot.nodes) {
    await expect.poll(async () => { try { return JSON.parse(await probe.node(`const r=await fetch(${JSON.stringify(`http://${host}:8081/reload`)},{method:'POST'});if(!r.ok)throw Error('reload');console.log(await r.text());`)).version; } catch { return null; } }, { timeout: 120000 }).toBe(deployed.version);
  }
  return deployed;
}
async function queueCommand(cli, verb, slot, name) {
  const read = async action => JSON.parse((await cli(['queue', action, name, '--json'], slot)).trim());
  const result = await read(verb);
  if (!['pause', 'resume'].includes(verb)) return result;
  const observed = await read('info');
  assert.equal(observed.paused, verb === 'pause');
  return observed;
}
