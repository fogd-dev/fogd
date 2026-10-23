import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, stat, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { readRuntimePolicy, writeRuntimePolicy } from '../src/runtime-policy-file.mjs';
import { runtimePolicyIdentity } from '../src/runtime-policy.mjs';
import { policy, environment } from './fixtures/runtime-policy.mjs';

const durable = () => ({ ...policy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'] });
const failed = { code: 'RUNTIME_POLICY_WRITE_FAILED' };
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-fresh-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'data'); await mkdir(target, { mode: 0o755 }); return { root, target };
}

test('create-only installs a fresh policy with private permissions and the legacy receipt', async t => {
  const { target } = await directory(t);
  const receipt = await writeRuntimePolicy(target, durable(), { createOnly: true });
  assert.deepEqual(receipt, { family: 'celld-cron-r1', admission: 'candidate', identitySha256: runtimePolicyIdentity(durable()) });
  assert.equal((await stat(target)).mode & 0o777, 0o700);
  assert.equal((await stat(join(target, 'policy.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(target), ['policy.json']);
  assert.equal(await readFile(join(target, 'policy.json'), 'utf8'), JSON.stringify(durable()) + '\n');
  assert.deepEqual(await readRuntimePolicy(target, environment()), durable());
});

test('create-only refuses retained policies and partial attempts without touching their bytes', async t => {
  for (const [name, bytes] of [['policy.json', JSON.stringify(policy()) + '\n'], ['policy.json', '{"sche'], ['abc.tmp', 'partial']]) {
    const { target } = await directory(t);
    await writeFile(join(target, name), bytes, { mode: 0o600 });
    await assert.rejects(writeRuntimePolicy(target, durable(), { createOnly: true }), failed);
    assert.deepEqual(await readdir(target), [name]);
    assert.equal(await readFile(join(target, name), 'utf8'), bytes);
    assert.equal((await stat(target)).mode & 0o777, 0o755, 'refusal happens before chmod');
  }
});

test('create-only refuses a second install, symlinks, missing and writable directories', async t => {
  const { root, target } = await directory(t);
  await writeRuntimePolicy(target, durable(), { createOnly: true });
  const before = await readFile(join(target, 'policy.json'));
  const next = durable(); next.admission = 'qualified';
  await assert.rejects(writeRuntimePolicy(target, next, { createOnly: true }), failed);
  assert.deepEqual(await readFile(join(target, 'policy.json')), before);
  const empty = join(root, 'empty'); await mkdir(empty);
  await symlink(empty, join(root, 'link'));
  await assert.rejects(writeRuntimePolicy(join(root, 'link'), durable(), { createOnly: true }), failed);
  await assert.rejects(writeRuntimePolicy(join(root, 'absent'), durable(), { createOnly: true }), failed);
  await chmod(empty, 0o777);
  await assert.rejects(writeRuntimePolicy(empty, durable(), { createOnly: true }), failed);
  assert.deepEqual(await readdir(empty), []);
});

test('legacy writes still replace by default', async t => {
  const { target } = await directory(t);
  await writeRuntimePolicy(target, policy());
  const next = policy(); next.admission = 'qualified';
  await writeRuntimePolicy(target, next);
  assert.deepEqual(await readRuntimePolicy(target, environment()), next);
});

test('fresh import entrypoint refuses non-durable profiles before touching /data', async () => {
  const code = await new Promise(resolve => {
    const child = execFile(process.execPath, ['packages/platform/src/import-fresh-runtime-policy.mjs'], { timeout: 5000 }, error => resolve(error?.code ?? 0));
    child.stdin.end(JSON.stringify(policy()));
  });
  assert.notEqual(code, 0);
});
