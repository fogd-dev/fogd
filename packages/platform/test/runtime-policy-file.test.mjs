import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, stat, symlink, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readRuntimePolicy, writeRuntimePolicy } from '../src/runtime-policy-file.mjs';
import { policy, environment } from './fixtures/runtime-policy.mjs';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-runtime-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const refused = { code: 'RUNTIME_POLICY_REFUSED' };
const exec = promisify(execFile);

test('an absent policy directory selects the legacy path', async t => {
  const root = await directory(t);
  assert.equal(await readRuntimePolicy(join(root, 'absent'), environment()), null);
});
test('an empty policy volume refuses instead of selecting legacy', async t => {
  const root = await directory(t);
  await assert.rejects(readRuntimePolicy(root, environment()), refused);
});
test('a durable policy has private permissions and a bound identity', async t => {
  const root = await directory(t), target = join(root, 'authority');
  await mkdir(target, { mode: 0o700 });
  const receipt = await writeRuntimePolicy(target, policy());
  assert.deepEqual(receipt, { family: 'celld-cron-r1', admission: 'candidate', identitySha256: 'f2df9a691889d54bbb4c9a1f550a1d687c0572cd26f13ef639de4c482d331b5d' });
  assert.equal((await stat(target)).mode & 0o777, 0o700);
  assert.equal((await stat(join(target, 'policy.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readRuntimePolicy(target, environment()), policy());
  assert.deepEqual(await readdir(target), ['policy.json']);
});
test('replacement persists a complete new policy without temporary files', async t => {
  const root = await directory(t);
  await writeRuntimePolicy(root, policy());
  const next = policy(); next.admission = 'qualified';
  await writeRuntimePolicy(root, next);
  assert.equal(JSON.parse(await readFile(join(root, 'policy.json'), 'utf8')).admission, 'qualified');
  assert.deepEqual(await readdir(root), ['policy.json']);
});
test('invalid policy refuses before creating its volume directory', async t => {
  const root = await directory(t), target = join(root, 'authority'), input = policy(); input.secret = 'private-do-not-echo';
  await assert.rejects(writeRuntimePolicy(target, input), refused);
  await assert.rejects(lstat(target), { code: 'ENOENT' });
});
test('a valid policy requires an existing volume directory', async t => {
  const root = await directory(t), target = join(root, 'unmounted');
  await assert.rejects(writeRuntimePolicy(target, policy()), { code: 'RUNTIME_POLICY_WRITE_FAILED' });
  await assert.rejects(lstat(target), { code: 'ENOENT' });
});
test('invalid replacement leaves the prior policy unchanged', async t => {
  const root = await directory(t);
  await writeRuntimePolicy(root, policy());
  const next = policy(); next.schema = 1;
  await assert.rejects(writeRuntimePolicy(root, next), refused);
  assert.equal(JSON.parse(await readFile(join(root, 'policy.json'), 'utf8')).schema, 2);
  assert.deepEqual(await readdir(root), ['policy.json']);
});
test('a policy file symlink cannot redirect authority to another file', async t => {
  const root = await directory(t), target = join(root, 'authority'), other = join(root, 'other.json');
  await mkdir(target, { mode: 0o700 }); await writeFile(other, JSON.stringify(policy()), { mode: 0o600 });
  await symlink(other, join(target, 'policy.json'));
  await assert.rejects(readRuntimePolicy(target, environment()), refused);
});
test('a FIFO policy file is refused without hanging startup', async t => {
  const root = await directory(t);
  await exec('mkfifo', [join(root, 'policy.json')]);
  const module = new URL('../src/runtime-policy-file.mjs', import.meta.url).href;
  const code = `import assert from'node:assert/strict';import{readRuntimePolicy}from${JSON.stringify(module)};await assert.rejects(readRuntimePolicy(${JSON.stringify(root)},${JSON.stringify(environment())}),{code:'RUNTIME_POLICY_REFUSED'});`;
  await exec(process.execPath, ['--input-type=module', '-e', code], { timeout: 5000, killSignal: 'SIGKILL' });
});
test('a symlinked policy directory is refused for reads and writes', async t => {
  const root = await directory(t), target = join(root, 'authority'), link = join(root, 'link');
  await mkdir(target, { mode: 0o700 }); await writeRuntimePolicy(target, policy()); await symlink(target, link);
  await assert.rejects(readRuntimePolicy(link, environment()), refused);
  await assert.rejects(writeRuntimePolicy(link, policy()), { code: 'RUNTIME_POLICY_WRITE_FAILED' });
  assert.deepEqual(await readdir(target), ['policy.json']);
  assert.equal(JSON.parse(await readFile(join(target, 'policy.json'), 'utf8')).family, 'celld-cron-r1');
});
test('a group-writable policy file is refused', async t => {
  const root = await directory(t);
  await writeRuntimePolicy(root, policy()); await chmod(join(root, 'policy.json'), 0o620);
  await assert.rejects(readRuntimePolicy(root, environment()), refused);
});
test('an oversized policy file is refused', async t => {
  const root = await directory(t);
  await writeFile(join(root, 'policy.json'), JSON.stringify(policy()).padEnd(65537, ' '), { mode: 0o600 });
  await assert.rejects(readRuntimePolicy(root, environment()), refused);
});
test('malformed JSON never exposes private input in diagnostics', async t => {
  const root = await directory(t);
  await writeFile(join(root, 'policy.json'), '{"private":"must-not-echo"', { mode: 0o600 });
  await assert.rejects(readRuntimePolicy(root, environment()), { code: 'RUNTIME_POLICY_REFUSED', message: 'Installed runtime policy is invalid or does not match this installation' });
});
test('reading an installed policy requires its environment binding', async t => {
  const root = await directory(t); await writeRuntimePolicy(root, policy());
  await assert.rejects(readRuntimePolicy(root), refused);
});
test('a failed rename keeps the target and removes only its temporary file', async t => {
  const root = await directory(t); await mkdir(join(root, 'policy.json'));
  await assert.rejects(writeRuntimePolicy(root, policy()), { code: 'RUNTIME_POLICY_WRITE_FAILED' });
  assert.equal((await stat(join(root, 'policy.json'))).isDirectory(), true);
  assert.deepEqual(await readdir(root), ['policy.json']);
});
