import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { beginDurableEnrollment } from '../src/runtime/enrollment-record.mjs';

const identity = { project: 'fixture', installation: 'a'.repeat(64), planSha256: 'b'.repeat(64) };
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'fogd-enrollment-ready-')); t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.fogd', 'installations', 'fixture'); return { home, directory };
}
function ready(home) {
  const module = new URL('../src/runtime/installation-state.mjs', import.meta.url).href;
  const code = `import{assertRuntimeReady}from${JSON.stringify(module)};try{await assertRuntimeReady('fixture');console.log('ready')}catch(error){console.log(error.code || 'refused');process.exitCode=1}`;
  return new Promise(resolve => execFile(process.execPath, ['--input-type=module', '-e', code], { env: { FOGD_HOME: home }, timeout: 15000 }, (error, stdout) => resolve({ code: error?.code || 0, output: stdout.trim() })));
}
test('a legacy project with no host enrollment directory retains its existing readiness path', async t => {
  const f = await fixture(t); assert.deepEqual(await ready(f.home), { code: 0, output: 'ready' });
});
test('normal CLI readiness refuses pending enrollment and accepts only matched completion', async t => {
  const f = await fixture(t); await mkdir(f.directory, { recursive: true, mode: 0o700 });
  const record = await beginDurableEnrollment(f.directory, identity);
  assert.deepEqual(await ready(f.home), { code: 1, output: 'ENROLLMENT_NOT_READY' });
  const before = await readFile(join(f.directory, 'enrollment.pending.json')); await record.complete('c'.repeat(64));
  assert.deepEqual(await ready(f.home), { code: 0, output: 'ready' });
  assert.deepEqual(await readFile(join(f.directory, 'enrollment.pending.json')), before);
});
test('an orphan completion cannot make an installation ready', async t => {
  const f = await fixture(t); await mkdir(f.directory, { recursive: true, mode: 0o700 });
  const record = await beginDurableEnrollment(f.directory, identity); await record.complete('c'.repeat(64)); await rm(join(f.directory, 'enrollment.pending.json'));
  assert.deepEqual(await ready(f.home), { code: 1, output: 'ENROLLMENT_NOT_READY' });
});
