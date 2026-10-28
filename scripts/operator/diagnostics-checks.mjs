import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertNoSecrets } from '../cron-probe/selected/privacy.mjs';
import { waitFor } from '../cron-probe/selected/https.mjs';

const commands = { observe: ['observe/command.mjs', 'observeCommand'], check: ['check/command.mjs', 'checkCommand'], logs: ['logs/command.mjs', 'logsCommand'] };
export async function diagnostic(host, fixture, command, app, extra = []) {
  const [file, handler] = commands[command], url = new URL(`../../packages/cli/src/${file}`, import.meta.url).href;
  const args = [app, '--installation', host.project, ...extra];
  const code = `const m=await import(${JSON.stringify(url)});await m[${JSON.stringify(handler)}](${JSON.stringify(args)},{candidateEnrollment:true});`;
  const stdout = await host.run(process.execPath, ['--input-type=module', '-e', code]);
  assertNoSecrets([stdout], Object.values(fixture.secrets)); return JSON.parse(stdout);
}
export function readyDiagnostic(host, fixture, app) {
  return waitFor('confirmed native diagnostic', async () => {
    const report = await diagnostic(host, fixture, 'observe', app);
    return report.nativeReadiness === 'confirmed' && report;
  }, 90000);
}
export async function checkDiagnostic(host, fixture, app, status) {
  const report = await diagnostic(host, fixture, 'check', app, ['--path', '/api/diagnostic', '--ca', host.env.NODE_EXTRA_CA_CERTS]);
  assert.equal(report.ingressResponse.state, 'observed'); assert.equal(report.ingressResponse.httpStatus, status);
  assert.equal(report.responseContents, 'withheld'); assert.equal(report.applicationExecution, 'not-proven'); assert.equal(report.applicationHealth, 'not-observed');
  assert.ok(!JSON.stringify(report).includes('diagnostic-response-')); return report;
}
export async function captureDiagnostic(host, fixture, app, label) {
  const output = join(host.output, label), report = await diagnostic(host, fixture, 'logs', app, ['--output', output]);
  assert.equal(report.status, 'captured'); assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.deepEqual(Object.values(report.scope), ['matched-at-boundaries', 'matched-at-boundaries', 'matched-at-boundaries']);
  const files = {}, streams = [], other = app === 'baseline' ? 'peer' : 'baseline';
  for (const capture of report.captures) {
    assert.equal(capture.exitCode, 0); assert.equal(capture.signal, null);
    for (const name of Object.values(capture.files)) {
      const path = join(output, name), bytes = await readFile(path); streams.push(bytes);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assertNoSecrets([bytes], [fixture.secrets[other]]);
      files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
  }
  assert.ok(streams.some(bytes => bytes.includes(Buffer.from(fixture.secrets[app]))), 'Selected app secret must be present in its private capture');
  const manifest = await readFile(join(output, 'capture.json'));
  assert.equal((await stat(join(output, 'capture.json'))).mode & 0o777, 0o600);
  assertNoSecrets([manifest, JSON.stringify(report)], Object.values(fixture.secrets));
  return { report, files, selectedSecretInPrivateFiles: true, otherAppSecretAbsent: true, manifestsAndTerminalWithholdSecrets: true };
}
