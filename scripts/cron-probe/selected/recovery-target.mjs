import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeResolved } from '../../../packages/cli/src/recovery/bundle.mjs';
import { readPolicyVolume } from '../../../packages/cli/src/runtime/policy-volume.mjs';
import { runtimePolicyIdentity } from '../../../packages/platform/src/runtime-policy.mjs';
import { composeArgs, json, docker } from '../../../packages/cli/src/recovery/docker.mjs';
import { commandRunner, commandJson } from './commands.mjs';
import { privateNetworks } from './resources.mjs';
import { expectRefusal, commandRefusal } from './evidence.mjs';
import { cleanupSelectedHost } from './host.mjs';
import { recoveryFence } from './recovery-fence.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url)), cli = join(repo, 'packages/cli/bin/fogd.js');
export async function recoveryTarget(source, bundle, output, installations = [source], snapshotImages) {
  await mkdir(output, { mode: 0o700 });
  const project = `fogd-selected-recovery-${randomBytes(8).toString('hex')}`, destination = join(output, 'restored');
  const env = { ...source.env, COMPOSE_PROJECT_NAME: project }, run = commandRunner(output, env);
  const target = { output, project, sourceProject: source.project, env, run, entry: source.entry, adminPort: source.adminPort, gatewayPort: source.gatewayPort,
    command: (args, options) => run(process.execPath, [cli, ...args], options),
    json: async (args, options) => commandJson(await run(process.execPath, [cli, ...args], options)),
  };
  const identity = runtimePolicyIdentity(source.policy), networks = await privateNetworks(installations.flatMap(host => Object.values(host.policy.networks)));
  const selector = { runtime: source.entry.id, candidateEnrollment: true, expectedIdentity: identity, networks };
  await writeFile(join(output, 'selection.json'), JSON.stringify({ sourceProject: source.project, project, bundle, identity, networks }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  target.restoreFence = await recoveryFence(target, installations);
  target.refusals = {};
  try {
    target.refusals.candidate = await expectRefusal(target, ['restore', bundle, '--project', project, '--output', destination, '--runtime', source.entry.id, '--expected-identity', identity], /candidate; ordinary enrollment remains closed/);
    await requireUnwritten(target, destination);
    target.refusals.noSelector = await expectRefusal(target, ['restore', bundle, '--project', project, '--output', destination], /Installed runtime requires a matching independently checked runtime profile/);
    await requireUnwritten(target, destination);
    const wrongCode = `import{restore}from ${JSON.stringify(new URL('../../../packages/cli/src/recovery/restore.mjs', import.meta.url).href)};await restore(${JSON.stringify(bundle)},${JSON.stringify(project)},${JSON.stringify(destination)},${JSON.stringify({ ...selector, expectedIdentity: '0'.repeat(64) })});`;
    target.refusals.wrongIdentity = await commandRefusal(run(process.execPath, ['--input-type=module', '-e', wrongCode]), /Snapshot storage identity differs from the independently expected identity/);
    await requireUnwritten(target, destination);
    const code = `import{stackRoot}from ${JSON.stringify(new URL('../../../packages/cli/src/local.mjs', import.meta.url).href)};if(stackRoot!==process.env.FOGD_HOME)throw Error('Recovery home mismatch');console.log(JSON.stringify({resolvedHome:stackRoot}));import{restore}from ${JSON.stringify(new URL('../../../packages/cli/src/recovery/restore.mjs', import.meta.url).href)};await restore(${JSON.stringify(bundle)},${JSON.stringify(project)},${JSON.stringify(destination)},${JSON.stringify(selector)});`;
    const restored = await run(process.execPath, ['--input-type=module', '-e', code], { timeout: 300000 });
    target.resolvedHome = JSON.parse(restored.split('\n').find(line => line.startsWith('{"resolvedHome":'))).resolvedHome;
    assert.equal(target.resolvedHome, source.env.FOGD_HOME);
    const canonical = join(env.FOGD_HOME, '.fogd/installations', project);
    target.config = composeResolved(JSON.parse(await readFile(join(canonical, 'compose.json'))));
    assert.deepEqual(target.config, composeResolved(JSON.parse(await readFile(join(destination, 'compose.json')))));
    target.policy = await readPolicyVolume(source.entry.image, target.config.volumes['runtime-policy'].name, target.config.services.controller.environment);
    assert.equal(runtimePolicyIdentity(target.policy), identity); assert.deepEqual(target.policy.networks, networks);
    assert.deepEqual(target.policy, { ...source.policy, networks });
    const summary = JSON.parse(await readFile(join(destination, 'restored.json')));
    assert.equal(summary.identitySha256, identity); assert.equal(summary.runtimeFamily, source.entry.id);
    await assert.rejects(access(join(canonical, 'restore.pending.json')), { code: 'ENOENT' });
    const relation = JSON.parse(await readFile(join(canonical, 'recovery-source.json'))); assert.equal(relation.sourceProject, source.project);
    assert.deepEqual(relation.volumes, Object.keys(source.config.volumes).sort().map(name => source.config.volumes[name].name));
    for (const name of Object.keys(source.config.volumes)) assert.notEqual(target.config.volumes[name].name, source.config.volumes[name].name);
    Object.assign(target, await createdRuntime(target, snapshotImages));
    target.compose = args => run('docker', [...composeArgs(join(canonical, 'compose.json'), project), ...args]);
    return target;
  } catch (error) {
    try { await cleanupSelectedHost(target); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Restore target and its cleanup failed'); }
    throw error;
  }
}

async function requireUnwritten(target, destination) {
  await assert.rejects(access(destination), { code: 'ENOENT' });
  await assert.rejects(access(join(target.env.FOGD_HOME, '.fogd/installations', target.project)), { code: 'ENOENT' });
  for (const command of [['ps', '-aq'], ['volume', 'ls', '-q'], ['network', 'ls', '-q']]) {
    assert.equal((await docker([...command, '--filter', `label=com.docker.compose.project=${target.project}`])).trim(), '');
  }
}

async function createdRuntime(target, snapshotImages) {
  const project = target.project;
  const ids = (await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).trim().split('\n').filter(Boolean);
  const initial = await json(['inspect', ...ids]); assert.equal(initial.length, 8);
  assert.ok(initial.every(container => !container.State.Running && !container.State.Restarting && !container.State.Paused && container.RestartCount === 0 && container.State.StartedAt.startsWith('0001-')));
  const initialServices = initial.map(container => {
    const service = container.Config.Labels['com.docker.compose.service'];
    const image = service === 'minio' ? target.entry.storageImage : target.entry.image;
    assert.equal(container.Image, image); assert.equal(container.Config.Image, image);
    assert.equal(container.Image, snapshotImages[service]);
    return { service, startedAt: container.State.StartedAt, image: container.Image, configuredImage: container.Config.Image };
  });
  const networks = await json(['network', 'inspect', ...Object.values(target.config.networks).map(network => network.name)]);
  for (const [name, network] of Object.entries(target.config.networks)) {
    const actual = networks.find(value => value.Name === network.name);
    assert.deepEqual(actual.IPAM.Config.map(value => value.Subnet), [target.policy.networks[name]]);
  }
  return { initialServices, networks };
}
