import { interruptAfterControllerRestore } from './recovery-fault.mjs';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configEnv, compose, stackRoot, run } from '../packages/cli/src/local.mjs';
import { projectContainers } from '../packages/cli/src/recovery/docker.mjs';
import { platformClient } from './platform-client.mjs';
import { expect } from './guestbook-browser.mjs';

const exec = promisify(execFile), env = await configEnv(), source = env.COMPOSE_PROJECT_NAME;
assert.match(source || '', /^fogd-m10[a-z0-9-]*$/);
const suffix = process.argv[3] ? `-${process.argv[3]}` : '';
assert.match(suffix, /^(?:-[a-z0-9-]+)?$/);
const cli = join(stackRoot, 'packages/cli/bin/fogd.js');
const bundle = join(stackRoot, '.fogd', `${source}-snapshot`), target = `${source}-interrupted${suffix}`;
const output = join(stackRoot, '.fogd', `${target}-config`);
const state = JSON.parse((await exec('tar', ['-xOf', join(bundle, 'controller.tar'), './state.json'])).stdout);
const digest = state.deployments[state.apps.notebook.active].digest;
const args = ['retire', bundle, '--app', 'notebook', '--digest', digest, '--project', target, '--output', output];
assert.ok((await projectContainers(source)).every(c => !c.State.Running));
await interruptAfterControllerRestore({ cli, args, env, project: target, shim: join(stackRoot, '.fogd', `${source}-fault-injection${suffix}`) });
for (const file of ['compose.json', 'restored.json']) await assert.rejects(access(join(output, file)));
assert.ok((await projectContainers(target)).every(c => !c.State.Running));
await assert.rejects(exec(process.execPath, [cli, ...args], { env, timeout: 900000 }), error => /already has containers/.test(error.stderr));
const retry = `${source}-retry${suffix}`, retryOutput = join(stackRoot, '.fogd', `${retry}-config`);
await run(process.execPath, [cli, 'retire', bundle, '--app', 'notebook', '--digest', digest, '--project', retry, '--output', retryOutput], { env });
assert.ok((await projectContainers(retry)).every(c => !c.State.Running));
assert.ok(JSON.parse(await readFile(join(retryOutput, 'restored.json'), 'utf8')).retirement);

if (process.argv[2] && process.argv[2] !== '-') {
  const oldBundle = resolve(process.argv[2]);
  const old = JSON.parse((await exec('tar', ['-xOf', join(oldBundle, 'controller.tar'), './state.json'])).stdout);
  const [name, app] = Object.entries(old.apps).find(([, app]) => app.active && app.route === 'active' && !app.uncertain && !app.quarantined);
  const obsolete = `${source}-obsolete-runtime${suffix}`, destination = join(stackRoot, '.fogd', `${obsolete}-config`);
  await assert.rejects(exec(process.execPath, [cli, 'retire', oldBundle, '--app', name, '--digest', old.deployments[app.active].digest, '--project', obsolete, '--output', destination], { env, timeout: 900000 }), error => /runtime does not support retirement/.test(error.stderr));
  assert.equal((await projectContainers(obsolete)).length, 0);
  await assert.rejects(access(join(destination, 'compose.json')));
  console.log('PASS: old snapshot runtime refused before target containers');
}

const ordinary = `${source}-ordinary${suffix}`, ordinaryOutput = join(stackRoot, '.fogd', `${ordinary}-config`);
await run(process.execPath, [cli, 'restore', bundle, '--project', ordinary, '--output', ordinaryOutput], { env });
const liveEnv = { ...env, COMPOSE_PROJECT_NAME: `${source}-retired`, FOGD_COMPOSE_FILE: join(stackRoot, '.fogd', `${source}-retired-config`, 'compose.json') };
const ordinaryEnv = { ...env, COMPOSE_PROJECT_NAME: ordinary, FOGD_COMPOSE_FILE: join(ordinaryOutput, 'compose.json') };
const client = await platformClient(env);
await compose(['stop'], liveEnv);
try {
  await compose(['up', '-d', '--pull', 'never'], ordinaryEnv);
  await expect.poll(async () => { try { return (await client.appRequest('notebook', '/api/entries')).status; } catch { return 0; } }, { timeout: 120000 }).toBe(200);
  const data = await (await client.appRequest('notebook', '/api/entries')).json();
  assert.equal(data.count, 1); assert.equal(data.entries[0].id, 'retained-before-retirement'); assert.equal(data.entries[0].body, 'Old R2 bytes');
} finally { await compose(['stop'], ordinaryEnv); await compose(['up', '-d', '--pull', 'never'], liveEnv); }
await expect.poll(async () => { try { return (await client.appRequest('replacement', '/api/entries')).status; } catch { return 0; } }, { timeout: 120000 }).toBe(200);
assert.equal((await client.appRequest('notebook', '/api/entries')).status, 404);
console.log('PASS: interrupted target has no start file or receipt, same-target retry refused, fresh-target retry succeeds stopped, ordinary restore retains old app state and demonstrates resurrection boundary');
