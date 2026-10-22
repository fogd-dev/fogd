import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeCli } from './fixtures/runtime-cli.mjs';

const exec = promisify(execFile), identity = 'a'.repeat(64);
const networks = { control: '10.253.180.0/24', 'fleet-1': '10.253.181.0/24', 'fleet-2': '10.253.182.0/24' };

async function fixture(t, admission = 'qualified') {
  const root = await mkdtemp(join(tmpdir(), 'fogd-network-options-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = await runtimeCli(root, admission), plan = join(root, 'networks.json');
  const invoke = values => exec(process.execPath, ['--input-type=module', '-e',
    `import{recoveryOptions}from ${JSON.stringify(cli.module('recovery-options.mjs'))};console.log(JSON.stringify(await recoveryOptions(${JSON.stringify(values)})));`]);
  return { root, ...cli, plan, invoke, values: { runtime: cli.entry.id, 'expected-identity': identity, 'network-plan': plan } };
}

test('qualified recovery reads independent placement without changing runtime or source identity', async t => {
  const f = await fixture(t);
  await writeFile(f.plan, JSON.stringify(networks).padEnd(4096));
  const actual = JSON.parse((await f.invoke(f.values)).stdout);
  assert.deepEqual(actual, { runtime: f.entry.id, expectedIdentity: identity, networks });
  assert.deepEqual(JSON.parse((await f.invoke({})).stdout), {});
  assert.deepEqual(JSON.parse((await f.invoke({ runtime: f.entry.id, 'expected-identity': identity })).stdout), { runtime: f.entry.id, expectedIdentity: identity });
});

test('family admission and independent identity refuse before reading a network plan', async t => {
  for (const admission of ['candidate', 'qualified']) {
    const f = await fixture(t, admission);
    const invalid = admission === 'candidate' ? [f.values] : [
      { 'network-plan': f.plan },
      { ...f.values, runtime: 'unknown-family' },
      { ...f.values, 'expected-identity': undefined },
      { ...f.values, 'expected-identity': 'A'.repeat(64) },
    ];
    for (const values of invalid) await assert.rejects(f.invoke(values), error =>
      /candidate|explicit runtime|Unknown shipped|independently recorded/.test(error.stderr) && !/Cannot read network plan/.test(error.stderr));
  }
});

test('network plan refuses malformed, oversized, incomplete, public and overlapping declarations', async t => {
  const f = await fixture(t);
  for (const content of [
    '{private-value', JSON.stringify(networks).padEnd(4097), 'null', '[]', '{}',
    JSON.stringify({ control: networks.control, 'fleet-1': networks['fleet-1'], 'fleet-3': networks['fleet-2'] }),
    JSON.stringify({ ...networks, image: 'private-value' }),
    JSON.stringify({ ...networks, control: '192.168.1.0/24' }),
    JSON.stringify({ ...networks, control: '10.253.180.1/24' }),
    JSON.stringify({ ...networks, control: '10.253.180.0/16' }),
    JSON.stringify({ ...networks, control: networks['fleet-1'] }),
  ]) {
    await writeFile(f.plan, content);
    await assert.rejects(f.invoke(f.values), error => /Cannot read network plan/.test(error.stderr) && !/private-value/.test(error.stderr));
  }
  await rm(f.plan);
  const target = join(f.root, 'valid-target.json'); await writeFile(target, JSON.stringify(networks));
  await symlink(target, f.plan);
  await assert.rejects(f.invoke(f.values), /Cannot read network plan/);
  await rm(f.plan); await mkdir(f.plan);
  await assert.rejects(f.invoke(f.values), /Cannot read network plan/);
});

test('real restore and retire parse and reject invalid placement before bundle, output or Docker effects', async t => {
  const f = await fixture(t);
  await writeFile(f.plan, '{private-value');
  for (const command of ['restore', 'retire']) {
    const args = [f.cli, command, join(f.root, 'missing-bundle'), '--project', 'target', '--output', join(f.root, 'output'),
      '--runtime', f.entry.id, '--expected-identity', identity, '--network-plan', f.plan];
    if (command === 'retire') args.push('--app', 'refresh', '--digest', identity);
    await assert.rejects(exec(process.execPath, args, { env: { ...process.env, PATH: '', FOGD_HOME: f.root } }), error =>
      error.code === 1 && /Cannot read network plan/.test(error.stderr) && !/private-value|missing-bundle|spawn docker/.test(error.stderr));
    for (const path of [join(f.root, 'output'), join(f.root, '.fogd')]) await assert.rejects(access(path), { code: 'ENOENT' });
  }
});

test('real startup refuses bad placement and family combinations before private configuration or Docker', async t => {
  const f = await fixture(t); await writeFile(f.plan, '{private-value');
  for (const args of [
    ['up', '--network-plan', f.plan],
    ['up', '--runtime', 'unknown-family', '--network-plan', f.plan],
    ['up', '--runtime', f.entry.id, '--network-plan', f.plan],
    ['up', '--installation', 'existing', '--network-plan', f.plan],
  ]) {
    await assert.rejects(exec(process.execPath, [f.cli, ...args], { env: { ...process.env, PATH: '', FOGD_HOME: f.root, FOGD_ENV_FILE: join(f.root, 'private.env') } }), error =>
      error.code === 1 && /explicit runtime|Unknown shipped|Cannot read network plan|omit.*--network-plan/.test(error.stderr) && !/private-value|docker could not start/.test(error.stderr));
    await assert.rejects(access(join(f.root, 'private.env')), { code: 'ENOENT' });
    await assert.rejects(access(join(f.root, '.fogd')), { code: 'ENOENT' });
  }
});

test('startup reads the same bounded plan as recovery and preserves runtime admission', async t => {
  const f = await fixture(t); await writeFile(f.plan, JSON.stringify(networks));
  const code = `import{startupOptions}from ${JSON.stringify(f.module('startup-options.mjs'))};console.log(JSON.stringify(await startupOptions(${JSON.stringify({ runtime: f.entry.id, 'network-plan': f.plan })})));`;
  assert.deepEqual(JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', code])).stdout), { runtime: f.entry.id, networks });
});
