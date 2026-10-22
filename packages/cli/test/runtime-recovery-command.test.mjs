import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';
import { runtimeCli } from './fixtures/runtime-cli.mjs';

const exec = promisify(execFile), cli = fileURLToPath(new URL('../bin/fogd.js', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-recovery-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), marker = join(root, 'docker-called'); await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\necho called > "$FOGD_TEST_MARKER"\nexit 99\n', { mode: 0o700 });
  const output = join(root, 'output'), bundle = join(root, 'missing-bundle');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FOGD_HOME: root, FOGD_ENV_FILE: join(root, 'operator.env'), FOGD_TEST_MARKER: marker };
  return { root, marker, output, bundle, env };
}

test('real restore and retirement commands refuse candidate or unpaired identity before bundle or Docker access', async t => {
  for (const command of ['restore', 'retire']) {
    const f = await fixture(t), base = [command, f.bundle, '--project', 'new-project', '--output', f.output];
    const client = await runtimeCli(f.root, 'candidate'), candidate = client.entry; assert.equal(candidate.admission, 'candidate');
    if (command === 'retire') base.push('--app', 'refresh', '--digest', 'a'.repeat(64), '--stop-scheduled-work');
    for (const [args, message] of [
      [['--runtime', candidate.id, '--expected-identity', 'a'.repeat(64)], /candidate; ordinary enrollment remains closed/],
      [['--expected-identity', 'a'.repeat(64)], /explicit runtime/],
      [['--runtime', candidate.id], /candidate; ordinary enrollment remains closed/],
      [['--runtime', 'unknown-family', '--expected-identity', 'a'.repeat(64)], /Unknown shipped/],
      [['--candidate-enrollment'], /Unknown option/],
    ]) {
      await assert.rejects(exec(process.execPath, [client.cli, ...base, ...args], { env: f.env }), error => error.code === 1 && message.test(error.stderr));
      for (const path of [f.marker, f.output, f.env.FOGD_ENV_FILE, join(f.root, '.fogd')]) await assert.rejects(access(path), { code: 'ENOENT' });
    }
  }
});

test('installation startup never bootstraps missing host state or accepts runtime/shared selection', async t => {
  const f = await fixture(t);
  for (const args of [
    ['up', '--installation', 'missing'],
    ['up', '--installation', 'missing', '--shared'],
    ['up', '--installation', 'missing', '--runtime', runtimeFamilies()[0].id],
  ]) await assert.rejects(exec(process.execPath, [cli, ...args], { env: f.env }), error => error.code === 1 && /Cannot read|omit --runtime/.test(error.stderr));
  for (const path of [f.marker, f.env.FOGD_ENV_FILE, join(f.root, '.fogd')]) await assert.rejects(access(path), { code: 'ENOENT' });
});

test('partial recovery blocks both startup commands even when its canonical Compose file exists', async t => {
  const f = await fixture(t), directory = join(f.root, '.fogd/installations/partial'); await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'compose.json'), JSON.stringify({ name: 'partial' }), { mode: 0o600 });
  await writeFile(join(directory, 'restore.pending.json'), '{}', { mode: 0o600 });
  await assert.rejects(exec(process.execPath, [cli, 'up', '--installation', 'partial'], { env: f.env }), error => error.code === 1 && /Restoration is incomplete/.test(error.stderr));
  const code = `import{selectedInstallation}from ${JSON.stringify(new URL('../src/runtime/installation.mjs', import.meta.url).href)};await selectedInstallation({name:'partial'});`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code], { env: f.env }), error => error.code === 1 && /Restoration is incomplete/.test(error.stderr));
  await assert.rejects(access(f.marker), { code: 'ENOENT' });
  assert.equal(await readFile(join(directory, 'restore.pending.json'), 'utf8'), '{}');
});

test('exclusive host reservation preserves an earlier enrollment configuration', async t => {
  const f = await fixture(t), module = new URL('../src/runtime/installation-state.mjs', import.meta.url).href;
  const code = `import{writeRuntimeConfiguration}from ${JSON.stringify(module)};await writeRuntimeConfiguration({name:'reserved',value:'first'},{reserve:true,recovery:true});await writeRuntimeConfiguration({name:'reserved',value:'replacement'},{reserve:true,recovery:true});`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code], { env: f.env }), error => error.code === 1 && /enrollment already exists/.test(error.stderr));
  const directory = join(f.root, '.fogd/installations/reserved');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'compose.json'))), { name: 'reserved', value: 'first' });
  await access(join(directory, 'restore.pending.json'));
  await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
});
