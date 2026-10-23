import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateGatewayLaunchPolicy, readGatewayLaunchPolicy, maxGatewayPolicyBytes } from '../src/gateway-launch-policy.mjs';

const launchPolicy = () => ({ schema: 1, policy: { installation: 'a'.repeat(64), slots: ['slot-1', 'slot-2'] },
  slots: ['slot-1', 'slot-2'].map(id => ({ id, nodes: [`${id}-a`, `${id}-b`] })) });
async function fixture(t, content = JSON.stringify(launchPolicy())) {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-gateway-policy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'policy.json'), content, { mode: 0o600 }); return dir;
}
test('installed gateway policy is read independently and returned without caller mutation', async t => {
  const dir = await fixture(t), expected = launchPolicy();
  assert.deepEqual(await readGatewayLaunchPolicy(dir), expected);
  const copy = validateGatewayLaunchPolicy(expected); expected.policy.installation = 'b'.repeat(64);
  assert.equal(copy.policy.installation, 'a'.repeat(64));
});
for (const [name, change] of [
  ['schema', value => { value.schema = 2; }],
  ['foreign launch option', value => { value.authorityPath = '/private'; }],
  ['bad installation', value => { value.policy.installation = 'PRIVATE'; }],
  ['extra policy key', value => { value.policy.token = 'PRIVATE'; }],
  ['third fleet', value => { value.policy.slots.push('slot-3'); }],
  ['duplicate fleet', value => { value.slots[1] = value.slots[0]; }],
  ['foreign node', value => { value.slots[0].nodes[0] = 'elsewhere'; }],
]) test(`${name} refuses without exposing policy contents`, () => {
  const value = launchPolicy(); change(value);
  assert.throws(() => validateGatewayLaunchPolicy(value), error => error.code === 'GATEWAY_POLICY_REFUSED' && !error.message.includes('PRIVATE') && !('cause' in error));
});
for (const [name, content] of [
  ['invalid JSON', 'PRIVATE invalid'], ['invalid UTF-8', Buffer.from([255])],
  ['oversized', ' '.repeat(maxGatewayPolicyBytes + 1)], ['empty', ''],
]) test(`${name} installed policy refuses`, async t => {
  const dir = await fixture(t, content);
  await assert.rejects(readGatewayLaunchPolicy(dir), { code: 'GATEWAY_POLICY_REFUSED' });
  assert.deepEqual(await readFile(join(dir, 'policy.json')), Buffer.from(content));
});
test('missing policy directory and empty mount refuse instead of selecting legacy routing', async t => {
  const dir = await fixture(t);
  await assert.rejects(readGatewayLaunchPolicy(join(dir, 'missing')), { code: 'GATEWAY_POLICY_REFUSED' });
  const empty = join(dir, 'empty'); await mkdir(empty);
  await assert.rejects(readGatewayLaunchPolicy(empty), { code: 'GATEWAY_POLICY_REFUSED' });
});
test('policy must be a regular file in an ordinary non-writable directory', async t => {
  const dir = await fixture(t), file = join(dir, 'policy.json'), alias = join(dir, 'alias');
  await symlink(dir, alias);
  await assert.rejects(readGatewayLaunchPolicy(alias), { code: 'GATEWAY_POLICY_REFUSED' });
  await chmod(file, 0o666);
  await assert.rejects(readGatewayLaunchPolicy(dir), { code: 'GATEWAY_POLICY_REFUSED' });
  await chmod(file, 0o600); await chmod(dir, 0o777);
  await assert.rejects(readGatewayLaunchPolicy(dir), { code: 'GATEWAY_POLICY_REFUSED' });
  await chmod(dir, 0o700); await rm(file); await mkdir(file);
  await assert.rejects(readGatewayLaunchPolicy(dir), { code: 'GATEWAY_POLICY_REFUSED' });
});
test('symlinked policy file refuses even when its target contains a valid policy', async t => {
  const dir = await fixture(t), original = join(dir, 'original');
  await writeFile(original, JSON.stringify(launchPolicy()), { mode: 0o600 }); await rm(join(dir, 'policy.json')); await symlink(original, join(dir, 'policy.json'));
  await assert.rejects(readGatewayLaunchPolicy(dir), { code: 'GATEWAY_POLICY_REFUSED' });
});
test('a FIFO policy refuses promptly without waiting for a writer', { timeout: 15000 }, async t => {
  const dir = await fixture(t), file = join(dir, 'policy.json'); await rm(file);
  await promisify(execFile)('mkfifo', [file]);
  const module = new URL('../src/gateway-launch-policy.mjs', import.meta.url).href;
  const script = `import { readGatewayLaunchPolicy } from ${JSON.stringify(module)};
    try { await readGatewayLaunchPolicy(${JSON.stringify(dir)}); process.exitCode = 1; }
    catch (error) { if (error.code !== 'GATEWAY_POLICY_REFUSED') throw error; console.log('refused'); }`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, env: {} });
  assert.equal(result.stdout.trim(), 'refused');
});
