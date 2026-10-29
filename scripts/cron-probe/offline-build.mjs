import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execute } from '../../packages/cli/src/recovery/execute.mjs';
import { checkedOfflineMounts } from './offline-mounts.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const exec = promisify(execFile);
export const offlineImage = 'sha256:2a8c24a10fcbb8d0fc0ed2c85c78115fab537ec4ee3c5679bc6238c0be84d4cf';
export async function runOfflineBuild(args, name, log, { image = offlineImage, retainResources = false } = {}) {
  assert.equal(args[0], 'run');
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  let id, before, after, stdout = '', stderr = '', failure;
  try {
    id = (await exec('docker', ['create', '--label', `fogd.offline.build=${name}`, ...args.slice(1).filter(value => value !== '--rm')], { timeout: 30000 })).stdout.trim();
    assert.match(id, /^[a-f0-9]{64}$/);
    before = await inspectBuild(id, name, args, image);
    await writeFile(join(dirname(log), 'container-before.json'), JSON.stringify(before, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    ({ stdout, stderr } = await exec('docker', ['start', '-a', id], { maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60000 }));
    after = JSON.parse(await execute('docker', ['inspect', id]))[0];
    await writeFile(join(dirname(log), 'container-after.json'), JSON.stringify({ id, state: after.State, restartCount: after.RestartCount }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    assert.equal(after.State.Running, false); assert.equal(after.State.ExitCode, 0); assert.equal(after.State.OOMKilled, false); assert.equal(after.RestartCount, 0);
  } catch (error) { stdout = error.stdout || stdout; stderr = error.stderr || stderr; failure = error; }
  const errors = failure ? [failure] : [];
  try { await writeFile(log, stdout + stderr, { mode: 0o600, flag: 'wx' }); } catch (error) { errors.push(error); }
  try {
    if (id) {
      const [owned] = JSON.parse(await execute('docker', ['inspect', id]));
      assert.equal(owned.Config.Labels['fogd.offline.build'], name); assert.equal(owned.Id, id);
      if (owned.State.Running) await execute('docker', ['stop', id]);
      if (!retainResources) await execute('docker', ['rm', id]);
    }
  } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Offline build failed; inspect its private build.log');
  return { ...before, exitCode: after.State.ExitCode, oomKilled: after.State.OOMKilled, restartCount: after.RestartCount };
}
async function inspectBuild(id, name, args, image) {
  const [container] = JSON.parse(await execute('docker', ['inspect', id]));
  assert.equal(container.Image, image); assert.equal(container.Name, `/${name}`);
  assert.equal(container.HostConfig.NetworkMode, 'none'); assert.equal(container.HostConfig.Memory, 2 * 1024 ** 3); assert.equal(container.HostConfig.NanoCpus, 2000000000);
  assert.deepEqual(container.HostConfig.CapDrop, ['ALL']); assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(container.HostConfig.Privileged, false); assert.equal(container.State.Status, 'created');
  assert.ok(container.Config.Env.every(value => /^(PATH|NODE_VERSION|VOID_REMOTE|WRANGLER_SEND_METRICS|FOGD_HOME|FOGD_FIXTURE_CRON)=/.test(value)), 'Offline build has an unexpected environment variable');
  const mounts = checkedOfflineMounts(container, args);
  return { id: container.Id, image: container.Image, network: container.HostConfig.NetworkMode, memoryBytes: container.HostConfig.Memory, nanoCpus: container.HostConfig.NanoCpus,
    mounts, credentialsAbsent: true, writableRootfs: !container.HostConfig.ReadonlyRootfs, memorySwapBytes: container.HostConfig.MemorySwap,
    capAdd: container.HostConfig.CapAdd, devices: container.HostConfig.Devices, pidsLimit: container.HostConfig.PidsLimit, user: container.Config.User };
}
export async function checkOfflineInputs(image) {
  assert.equal(resolve('.'), fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, ''), 'Run offline qualification from this checkout root');
  const paths = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/void@1.1.11.patch', 'examples/refresh/package.json', ...['cli', 'runtime', 'platform'].map(name => `packages/${name}/package.json`)];
  const code = `import{readFile}from'node:fs/promises';console.log(JSON.stringify(Object.fromEntries(await Promise.all(${JSON.stringify(paths)}.map(async name=>[name,await readFile(name,'utf8')])))));`;
  const before = JSON.parse(await execute('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--entrypoint', '/usr/local/bin/node', image, '--input-type=module', '-e', code]));
  const inputs = {};
  for (const name of paths) {
    const current = await readFile(name, 'utf8'); inputs[name] = hash(current);
    if (['package.json', 'packages/platform/package.json'].includes(name)) {
      const old = JSON.parse(before[name]), actual = JSON.parse(current), field = name === 'package.json' ? 'scripts' : 'exports';
      delete old[field]; delete actual[field]; assert.deepEqual(actual, old, 'Offline dependency declarations differ from the checked image');
    } else assert.equal(hash(current), hash(before[name]), 'Offline dependency inputs differ from the checked image');
  }
  return { image, inputHashes: inputs, ignoredMetadata: ['root scripts', 'platform exports'] };
}
