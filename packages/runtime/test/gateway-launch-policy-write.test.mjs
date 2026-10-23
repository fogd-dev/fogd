import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, stat, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readGatewayLaunchPolicy, writeGatewayLaunchPolicy } from '../src/gateway-launch-policy.mjs';

const launchPolicy = () => ({ schema: 1, policy: { installation: 'a'.repeat(64), slots: ['slot-1', 'slot-2'] },
  slots: ['slot-1', 'slot-2'].map(id => ({ id, nodes: [`${id}-a`, `${id}-b`] })) });
const failed = error => error.code === 'GATEWAY_POLICY_WRITE_FAILED' && !/a{64}|slot-/.test(error.message);
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-gateway-write-')); t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'data'); await mkdir(target, { mode: 0o700 }); return { root, target };
}

test('fresh gateway policy is created exclusively with public-read permissions and a digest receipt', async t => {
  const { target } = await directory(t), text = JSON.stringify(launchPolicy()) + '\n';
  assert.deepEqual(await writeGatewayLaunchPolicy(target, launchPolicy()),
    { installation: 'a'.repeat(64), sha256: createHash('sha256').update(text).digest('hex') });
  assert.equal((await stat(target)).mode & 0o777, 0o755);
  assert.equal((await stat(join(target, 'policy.json'))).mode & 0o777, 0o644);
  assert.deepEqual(await readdir(target), ['policy.json']);
  assert.equal(await readFile(join(target, 'policy.json'), 'utf8'), text);
  assert.deepEqual(await readGatewayLaunchPolicy(target), launchPolicy());
});

test('retained, partial and foreign files refuse before chmod and keep their bytes', async t => {
  for (const [name, bytes] of [['policy.json', JSON.stringify(launchPolicy())], ['policy.json', '{"sch'], ['stray', 'x']]) {
    const { target } = await directory(t);
    await writeFile(join(target, name), bytes);
    await assert.rejects(writeGatewayLaunchPolicy(target, launchPolicy()), failed);
    assert.deepEqual(await readdir(target), [name]);
    assert.equal(await readFile(join(target, name), 'utf8'), bytes);
    assert.equal((await stat(target)).mode & 0o777, 0o700);
  }
});

test('a second install refuses without overwriting', async t => {
  const { target } = await directory(t);
  await writeGatewayLaunchPolicy(target, launchPolicy());
  const other = launchPolicy(); other.policy.installation = 'b'.repeat(64);
  await assert.rejects(writeGatewayLaunchPolicy(target, other), failed);
  assert.deepEqual(await readGatewayLaunchPolicy(target), launchPolicy());
});

test('invalid plans, symlinked, missing and writable directories refuse without writes', async t => {
  const { root, target } = await directory(t);
  const bad = launchPolicy(); bad.slots[0].nodes[0] = 'elsewhere';
  await assert.rejects(writeGatewayLaunchPolicy(target, bad), { code: 'GATEWAY_POLICY_REFUSED' });
  await assert.rejects(writeGatewayLaunchPolicy(target, { ...launchPolicy(), extra: 1 }), { code: 'GATEWAY_POLICY_REFUSED' });
  assert.deepEqual(await readdir(target), []);
  await symlink(target, join(root, 'link'));
  await assert.rejects(writeGatewayLaunchPolicy(join(root, 'link'), launchPolicy()), failed);
  await assert.rejects(writeGatewayLaunchPolicy(join(root, 'absent'), launchPolicy()), failed);
  await chmod(target, 0o777);
  await assert.rejects(writeGatewayLaunchPolicy(target, launchPolicy()), failed);
  assert.deepEqual(await readdir(target), []);
});
