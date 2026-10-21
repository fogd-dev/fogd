import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';
import { verifyBundle, fingerprint } from '../../../packages/cli/src/recovery/bundle.mjs';
import { snapshotState } from '../../../packages/cli/src/recovery/snapshot-state.mjs';
import { restoreInstallation } from '../../../packages/cli/src/recovery/restore.mjs';
import { cronRestoreConfig } from '../../../packages/cli/src/runtime/cron-preboot.mjs';
import { compareSourceVolumes } from '../recovery/preservation.mjs';
import { retirementVariant } from './policy.mjs';
import { retirement } from './transitions.mjs';
import { sealedRetirementInstall } from './sealed-client.mjs';

const exec = promisify(execFile);

export async function ordinaryRefusal(source, point, operation, suffix) {
  const project = `${source.rootProject}-deny-${suffix}`, directory = join(source.rootDirectory, `deny-${suffix}`);
  const args = operation === 'retire' ? ['retire', point.directory, '--app', 'imports', '--digest', source.approvals.imports.digest, '--stop-queued-work'] : ['restore', point.directory];
  await assert.rejects(exec(process.execPath, ['packages/cli/bin/fogd.js', ...args, '--project', project, '--output', directory], { env: source.env, timeout: 180000 }),
    error => error.code === 1 && /matching independently checked runtime profile/.test(error.stderr));
  await noTarget(project, directory);
  const preservation = await compareSourceVolumes(source, point.directory);
  return { case: `ordinary-cli-${suffix}`, refused: true, noTargetResources: true, preservation };
}
export async function wrongVariantRefusal(source, point) {
  const project = `${source.rootProject}-deny-policy`, directory = join(source.rootDirectory, 'deny-policy');
  const bundle = await verifyBundle(point.directory), wrong = retirementVariant(source.authority, 'a');
  assert.equal(source.variant, 'initial');
  cronRestoreConfig(await snapshotState(point.directory), bundle.config, source.runtimeProfile);
  await assert.rejects(restoreInstallation({ ...bundle, dir: point.directory }, project, directory, null, wrong), { code: 'CRON_PREBOOT_REFUSED' });
  await noTarget(project, directory);
  return { case: 'wrong-independent-variant', refused: true, noTargetResources: true, preservation: await compareSourceVolumes(source, point.directory) };
}
async function noTarget(project, directory) {
  assert.equal((await projectContainers(project)).length, 0);
  for (const kind of ['volume', 'network']) assert.equal((await execute('docker', [kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])).trim(), '');
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
}
export async function retirementCleanupCheck(source, directory) {
  const original = source.snapshotFingerprints.get(directory); assert.ok(original);
  const point = { directory, manifest: (await verifyBundle(directory)).manifest }, output = join(source.rootDirectory, 'validation-failure'), project = `${source.project}-invalid`;
  let tampered = false;
  const digest = source.approvals.imports.digest, invalid = digest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  const install = async (probe, request) => {
    const target = await sealedRetirementInstall(probe, request);
    const file = join(request.directory, 'retirement.json'), plan = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(plan.digest, digest); plan.digest = invalid;
    await writeFile(file, JSON.stringify(plan), { mode: 0o600 }); tampered = true; return target;
  };
  await assert.rejects(retirement(source, point, 'imports', output, 'invalid', install), error => error.code === 'ERR_ASSERTION' && error.actual === invalid && error.expected === digest);
  assert.equal(tampered, true); assert.deepEqual(await fingerprint(join(directory, 'manifest.json')), original);
  assert.equal((await projectContainers(project)).length, 0);
  assert.equal((await execute('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])).trim(), '');
  const volumes = (await execute('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])).trim().split('\n').filter(Boolean);
  assert.deepEqual(volumes.sort(), Object.keys(source.config.volumes).map(name => `${project}_${name}`).sort());
  return { case: 'post-create-plan-validation', deliberatelyChangedDigest: true, refused: true, noTargetContainersOrNetworks: true, retainedVolumes: volumes, preservation: await compareSourceVolumes(source, directory) };
}
