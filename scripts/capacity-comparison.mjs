import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configEnv, compose, stackRoot } from '../packages/cli/src/local.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { composeResolved } from '../packages/cli/src/recovery/bundle.mjs';
import { recoveryLayout } from '../packages/cli/src/recovery/layout.mjs';
import { platformClient } from './platform-client.mjs';
import { expect } from './guestbook-browser.mjs';

const operator = await configEnv();
if (operator.NODE_EXTRA_CA_CERTS) operator.NODE_EXTRA_CA_CERTS = resolve(operator.NODE_EXTRA_CA_CERTS);
const [twoFile, threeFile, outputArg] = process.argv.slice(2);
assert.ok(twoFile && threeFile && outputArg && operator.FOGD_COMPOSE_FILE);
const output = resolve(outputArg); await mkdir(output, { mode: 0o700 });
const original = await installation(operator.FOGD_COMPOSE_FILE);
const phases = [await installation(twoFile), await installation(threeFile)];
assert.equal(phases[0].layout.fleets.length, 2); assert.equal(phases[1].layout.fleets.length, 3);
let active = original;
const evidence = { context: 'Shared Docker Desktop VM; restarted observations follow readiness probes. Same workload per existing app, plus one notebook workload at three fleets. Closed-loop paced reads, not saturation or production sizing.', phases: [] };
try {
  for (const phase of phases) {
    await stop(active); active = phase;
    await compose(['up', '-d', '--pull', 'never'], phase.env);
    const client = await platformClient(phase.env);
    const routes = [['accounts', '/'], ['replacement', '/api/entries'], ...(phase.layout.fleets.length === 3 ? [['third', '/api/entries']] : [])];
    for (const [app, path] of routes) await expect.poll(async () => { try { return (await client.appRequest(app, path)).status; } catch { return 0; } }, { timeout: 120000 }).toBe(200);
    const count = phase.layout.fleets.length;
    console.log(`Observing ${count} restarted fleets`);
    const cold = await metrics(phase, `${count}-restarted`, 6, 2000);
    const loads = routes.map(([app, path]) => {
      const file = join(output, `${count}-${app}-reads.json`), url = new URL(path, client.browserURL(app)).href;
      return execute(process.execPath, [join(stackRoot, 'scripts/capacity/load.mjs'), '--url', url, '--output', file, '--seconds', '120', '--concurrency', '4', '--delay', '100'], { env: phase.env, timeoutMs: 180000 }).then(() => readJSON(file));
    });
    const results = await Promise.allSettled([...loads, metrics(phase, `${count}-loaded`, 12, 5000)]);
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(r => r.reason), 'Capacity observation failed; inspect its private reports');
    const reads = results.slice(0, -1).map(r => r.value), loaded = results.at(-1).value;
    for (const report of reads) {
      assert.equal(report.errors, 0);
      assert.ok(report.requests > 0);
      for (const sample of loaded.samples) assert.ok(sample.startedAt >= report.startedAt && sample.finishedAt <= report.finishedAt, 'Every loaded sample must be inside every app request window');
    }
    const warm = await metrics(phase, `${count}-warm`, 6, 2000);
    evidence.phases.push({ fleets: count, project: phase.env.COMPOSE_PROJECT_NAME, routes, cold, loaded, warm, reads });
    await writeFile(join(output, 'comparison.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log(`PASS: ${count}-fleet read workload completed without errors`);
  }
} finally {
  await stop(active);
  await compose(['up', '-d', '--pull', 'never'], original.env);
}
console.log('PASS: paired two/three-fleet observation complete; original installation restarted');
async function installation(file) {
  const path = resolve(file), config = composeResolved(await readJSON(path));
  assert.match(config.name, /^fogd-m10[a-z0-9-]*$/);
  return { layout: recoveryLayout(config), env: { ...operator, COMPOSE_PROJECT_NAME: config.name, FOGD_COMPOSE_FILE: path } };
}
async function stop(phase) {
  await compose(['stop', 'workerd', 'controller'], phase.env);
  await compose(['stop', ...phase.layout.replicas], phase.env);
  await compose(['stop', 'minio', 'bucket-init'], phase.env);
}
async function metrics(phase, name, samples, interval) {
  const file = join(output, `${name}.json`);
  await execute(process.execPath, [join(stackRoot, 'scripts/capacity.mjs'), '--project', phase.env.COMPOSE_PROJECT_NAME, '--output', file, '--samples', String(samples), '--interval', String(interval)], { env: phase.env, timeoutMs: 180000 });
  return readJSON(file);
}
async function readJSON(file) { return JSON.parse(await readFile(file, 'utf8')); }
