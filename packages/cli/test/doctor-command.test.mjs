import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';

const exec = promisify(execFile), cli = new URL('../bin/fogd.js', import.meta.url).pathname;

test('doctor CLI emits JSON and text with documented exit codes, without leaking tool output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fogd-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'docker'), `#!${process.execPath}
console.log('private-tool-output'); console.error('private-diagnostic'); process.exit(1);
`, { mode: 0o700 });
  const env = { ...process.env, PATH: root, FOGD_HOME: root, FOGD_ENV_FILE: join(root, 'missing.env') };
  const qualified = runtimeFamilies().find(entry => entry.admission === 'qualified');
  const candidate = runtimeFamilies().find(entry => entry.admission === 'candidate');
  for (const [family, json, code] of [[qualified.id, true, 2], [qualified.id, false, 2], [candidate.id, true, 1]]) {
    let failure;
    try { await exec(process.execPath, [cli, 'doctor', '--runtime', family, ...(json ? ['--json'] : [])], { env, timeout: 15000 }); }
    catch (error) { failure = error; }
    assert.equal(failure?.code, code);
    assert.equal(failure.stderr, '');
    assert.ok(!failure.stdout.includes('private-'));
    if (json) {
      const report = JSON.parse(failure.stdout);
      assert.equal(report.family, family);
      assert.equal(report.status, code === 1 ? 'unsupported' : 'unverified');
    } else assert.match(failure.stdout, /\[unverified\] docker/);
  }
  await assert.rejects(exec(process.execPath, [cli, 'doctor'], { env }), error => error.code === 1 && /Usage: fogd doctor/.test(error.stderr));
  for (const args of [['--config', 'absent'], ['--runtime', qualified.id, '--config', 'absent', '--name', 'demo'], ['--runtime', qualified.id, '--online']]) {
    await assert.rejects(exec(process.execPath, [cli, 'doctor', ...args], { env }), error => error.code === 1 && /Usage: fogd doctor/.test(error.stderr));
  }
});
