import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { composeArgs, projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';
import { platformClient } from '../../platform-client.mjs';
import { expect } from '../../guestbook-browser.mjs';
import { stackRoot } from '../../../packages/cli/src/local.mjs';

export async function recoveryClient(directory, config, selected) {
  const file = join(directory, 'compose.json');
  const env = { ...process.env, ...selected, FOGD_ENV_FILE: join(directory, 'absent.env'), FOGD_COMPOSE_FILE: file, COMPOSE_PROJECT_NAME: config.name };
  const compose = (args, options = {}) => execute('docker', [...composeArgs(file, config.name), ...args], { env, ...options });
  const client = await platformClient(env), slots = JSON.parse(config.services.controller.environment.FOGD_SLOTS), slot = slots[0];
  const probe = { ...client, config, env, file, compose, slots, slot, daemon: false, project: config.name,
    node: code => compose(['exec', '-T', slot.nodes[0], 'node', '--input-type=module', '-e', code]),
    cli(args, selectedSlot = slot) {
      const bucket = `CELLD_BUCKET=s3://${config.services.controller.environment.FOGD_BUCKET}/${selectedSlot.prefix}`;
      return compose(probe.daemon
        ? ['exec', '-T', '-e', bucket, 'controller', 'celld', ...args]
        : ['run', '--rm', '--no-deps', '--entrypoint', 'celld', '-e', bucket, 'controller', ...args]);
    },
    command: args => execute(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), ...args], { env }),
    async save(name, value) { await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); },
  };
  return probe;
}
export async function waitForController(probe) {
  await expect.poll(async () => { try { return Boolean((await probe.api('/v1/admin')).csrf); } catch { return false; } }, { timeout: 120000 }).toBe(true);
  probe.daemon = true;
}
export async function requireDaemonStopped(probe) {
  const containers = await projectContainers(probe.project);
  for (const name of ['controller', 'workerd']) {
    const found = containers.find(value => value.Config.Labels['com.docker.compose.service'] === name);
    assert.ok(found); assert.equal(found.State.Running, false, `${name} must stay stopped during the cold observation`);
  }
}
export async function rootState(probe) {
  return JSON.parse(await probe.compose(['run', '--rm', '--no-deps', '--entrypoint', 'node', 'controller', '--input-type=module', '-e', "import{readFile}from'node:fs/promises';console.log(await readFile('/var/lib/fogd/state.json','utf8')); "]));
}
export async function restoredClient(source, bundle, name, directory) {
  assert.match(name, /^fogd-m11c-cron-recovery-/);
  try {
    await source.command(['restore', bundle, '--project', name, '--output', directory]);
    const config = JSON.parse(await readFile(join(directory, 'compose.json'), 'utf8'));
    const target = await recoveryClient(directory, config, source.env); target.identity = source.identity;
    assert.notEqual(target.project, source.project);
    for (const name of Object.keys(source.config.volumes)) assert.notEqual(target.config.volumes[name].name, source.config.volumes[name].name);
    return target;
  } catch (error) {
    try { await cleanupPartialRestore(source, name, directory); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `Restore and partial cleanup failed for ${name}`, { cause: error }); }
    throw error;
  }
}
async function cleanupPartialRestore(source, name, directory) {
  for (const file of ['compose.json', 'compose.pending.json']) {
    const path = join(directory, file);
    try { await access(path); } catch { continue; }
    await execute('docker', [...composeArgs(path, name), 'down'], { env: source.env });
    break;
  }
  assert.equal((await projectContainers(name)).length, 0, 'Partial restore needs explicit target cleanup; volumes must be retained');
}
