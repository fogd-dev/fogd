import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { access } from 'node:fs/promises';
import { observationFixture } from './fixtures/observation-cli.mjs';
const exec = promisify(execFile);
const cases = [
  ['observe', 'observe/command.mjs', 'observeCommand', {}, []],
  ['logs', 'logs/command.mjs', 'logsCommand', { FOGD_LOG_TEST: '1' }, ['--output']],
  ['check', 'check/command.mjs', 'checkCommand', { FOGD_CHECK_TEST: '1' }, ['--path', '/health']],
];
async function invoke(f, file, handler, args, selection, extra) {
  const url = pathToFileURL(join(f.root, 'cli/src', file)).href;
  const code = `const m=await import(${JSON.stringify(url)});await m[${JSON.stringify(handler)}](${JSON.stringify(args)},${JSON.stringify(selection)});`;
  return exec(process.execPath, ['--input-type=module', '-e', code], { env: { ...f.env, ...extra }, timeout: 20000 });
}
for (const [name, file, handler, extra, tail] of cases) test(`internal ${name} uses an independently enrolled candidate without promoting it`, async t => {
  const f = await observationFixture(t, { admission: 'candidate' }), output = join(f.root, 'capture');
  const args = ['sample', '--installation', f.project, ...tail, ...(name === 'logs' ? [output] : [])];
  const result = await invoke(f, file, handler, args, { candidateEnrollment: true }, extra), report = JSON.parse(result.stdout);
  assert.equal(report.app, 'sample');
  if (name === 'observe') assert.equal(report.nativeReadiness, 'confirmed');
  if (name === 'logs') assert.equal(report.status, 'captured');
  if (name === 'check') assert.equal(report.ingressResponse.state, 'observed');
  await assert.rejects(f.invoke(args, extra), /requires an enrolled qualified/);
});
for (const [name, file, handler, extra, tail] of cases) test(`invalid ${name} qualification refuses before Docker or output`, async t => {
  const f = await observationFixture(t, { admission: 'candidate' }), output = join(f.root, 'capture');
  const args = ['sample', '--installation', f.project, ...tail, ...(name === 'logs' ? [output] : [])];
  await assert.rejects(invoke(f, file, handler, args, { candidateEnrollment: 'true' }, extra), /Candidate observation/);
  assert.deepEqual(await f.calls(), []); await assert.rejects(access(output), { code: 'ENOENT' });
});
