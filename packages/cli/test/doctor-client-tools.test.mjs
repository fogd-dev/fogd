import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clientNodeFinding, inspectClientTools, minimumClientNode } from '../src/doctor/client-tools.mjs';

const checksum = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const statuses = report => Object.fromEntries(report.map(item => [item.id, item.status]));
const tools = async command => command === 'tar' ? 'bsdtar 3.5.3 - libarchive 3.5.3\n' : checksum + '  -\n';

for (const [version, expected] of [['24.20.99', 'unsupported'], ['24.21.0', 'supported'], ['25.0.0', 'supported'], ['24.21.0-rc.1', 'unverified'], ['private-node-version', 'unverified']]) {
  test(`client Node ${version} is classified as ${expected}`, () => {
    const report = clientNodeFinding(version); assert.equal(report.status, expected);
    assert.ok(!JSON.stringify(report).includes('private-node-version'));
  });
}
test('client prerequisites probe only bounded version output and known stdin', async () => {
  const calls = [], report = await inspectClientTools({ nodeVersion: '24.21.0', run: async (command, args, options) => {
    calls.push({ command, args, options }); return tools(command);
  } });
  assert.deepEqual(statuses(report), { 'client-node': 'supported', 'client-tar': 'supported', 'client-checksum': 'supported' });
  assert.deepEqual(calls, [
    { command: 'tar', args: ['--version'], options: { timeoutMs: 5000, maxOutputBytes: 8192 } },
    { command: 'sha256sum', args: [], options: { timeoutMs: 5000, maxOutputBytes: 8192, inputText: 'abc' } },
  ]);
});
test('a recognized GNU tar banner is observed without disclosing the remaining output', async () => {
  const report = await inspectClientTools({ nodeVersion: '24.21.0', run: async command => command === 'tar' ? 'tar (GNU tar) 1.35\nprivate-tool-value' : tools(command) });
  assert.equal(statuses(report)['client-tar'], 'supported'); assert.ok(!JSON.stringify(report).includes('private-tool-value'));
});
test('a successful unrecognized tar response remains unverified', async () => {
  const report = await inspectClientTools({ nodeVersion: '24.21.0', run: async command => command === 'tar' ? 'private-unrecognized-output' : tools(command) });
  assert.equal(statuses(report)['client-tar'], 'unverified'); assert.equal(statuses(report)['client-checksum'], 'supported');
  assert.ok(!JSON.stringify(report).includes('private-unrecognized-output'));
});
for (const [scenario, response] of [['wrong digest', '0'.repeat(64) + '  -\n'], ['filename instead of stdin', checksum + '  private-file\n']]) test(`checksum ${scenario} remains unverified despite process success`, async () => {
  const report = await inspectClientTools({ nodeVersion: '24.21.0', run: async command => command === 'sha256sum' ? response : tools(command) });
  assert.equal(statuses(report)['client-checksum'], 'unverified'); assert.equal(statuses(report)['client-tar'], 'supported');
  assert.ok(!JSON.stringify(report).includes('private-file'));
});
test('missing or failing client tools remain unverified without raw error output', async () => {
  const report = await inspectClientTools({ nodeVersion: '24.21.0', run: async () => { throw Error('private-environment-diagnostic'); } });
  assert.deepEqual(statuses(report), { 'client-node': 'supported', 'client-tar': 'unverified', 'client-checksum': 'unverified' });
  assert.ok(!JSON.stringify(report).includes('private-environment-diagnostic'));
});
test('doctor and the workspace declare the same minimum client Node version', async () => {
  const workspace = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(workspace.engines.node, '>=' + minimumClientNode);
});
