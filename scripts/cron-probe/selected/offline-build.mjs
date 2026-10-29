import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { offlineSourceHashes } from '../offline-project.mjs';
import { offlineImage, checkOfflineInputs, runOfflineBuild } from '../offline-build.mjs';
import { buildEnvironment } from '../../../packages/cli/src/build-env.mjs';
import { artifactDigest } from '../../../packages/runtime/src/artifact.mjs';
import { offlineVolumeInputs, verifyOfflinePackageMetadata } from './offline-volumes.mjs';

export async function negotiatedCapabilities(host, token) {
  const module = new URL('../../../packages/cli/src/deploy-capabilities.mjs', import.meta.url).href;
  const code = `import{deployCapabilities}from ${JSON.stringify(module)};console.log(JSON.stringify(await deployCapabilities(process.env.FOGD_SERVER,process.env.FOGD_DEPLOY_TOKEN,'refresh')));`;
  const capabilities = JSON.parse(await host.run(process.execPath, ['--input-type=module', '-e', code], { env: { ...buildEnvironment(host.env), FOGD_DEPLOY_TOKEN: token } }));
  assert.deepEqual(capabilities, { cronApps: true });
  await writeFile(join(host.output, 'negotiated-capabilities.json'), JSON.stringify(capabilities) + '\n', { mode: 0o644, flag: 'wx' });
  return capabilities;
}
export async function ordinaryOfflineBuild(host, project, directory, capabilities) {
  assert.deepEqual(capabilities, { cronApps: true });
  const image = host.sdkImage || offlineImage;
  const sourceFiles = await offlineSourceHashes(project), dependencyInputs = await checkOfflineInputs(image), output = resolve(directory); await mkdir(output, { mode: 0o700 });
  const packageMetadata = await verifyOfflinePackageMetadata(host, image);
  await writeFile(join(output, 'dependency-inputs.json'), JSON.stringify(dependencyInputs, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const bytes = JSON.stringify(capabilities) + '\n', capabilityFile = join(host.output, 'negotiated-capabilities.json');
  assert.equal(await readFile(capabilityFile, 'utf8'), bytes);
  const staged = await offlineVolumeInputs(host, project, sourceFiles, capabilityFile, output, image);
  const name = `fogd-ordinary-offline-${randomBytes(8).toString('hex')}`;
  const args = ['run', '--rm', '--pull', 'never', '--name', name, '--label', `fogd.qualifier.project=${host.project}`, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '2g', '--cpus', '2',
    '-e', 'FOGD_HOME=/results/home', '-e', 'VOID_REMOTE=0', '-e', 'WRANGLER_SEND_METRICS=false', ...staged.mounts.flatMap(mount => ['--mount', mount]),
    '--entrypoint', '/usr/local/bin/node', image, '/app/scripts/cron-probe/selected/offline-worker.mjs'];
  const container = await runOfflineBuild(args, name, join(output, 'build.log'), { image, retainResources: true });
  await host.run('docker', ['cp', container.id + ':/results/.', output], { timeout: 300000 });
  assert.equal(await readFile(capabilityFile, 'utf8'), bytes);
  const result = JSON.parse(await readFile(join(output, 'offline.json'))), payload = JSON.parse(await readFile(join(output, 'manifest.json')));
  assert.deepEqual(result.sourceFiles, sourceFiles); assert.deepEqual(await offlineSourceHashes(project), sourceFiles);
  assert.equal(result.network, 'none'); assert.equal(result.ordinaryBuildApi, 'buildArtifact'); assert.deepEqual(result.capabilities, capabilities);
  const digest = await artifactDigest(join(output, 'artifact')); assert.equal(digest, result.release.digest); assert.equal(payload.digest, digest); assert.equal(payload.app, 'refresh');
  assert.equal(result.capabilitiesSha256, createHash('sha256').update(bytes).digest('hex'));
  const verification = { ...result, image, dependencyInputs, packageMetadata, engineInputs: staged.receipt, container, sourceMountedReadOnly: true, credentialsNotPassed: true,
    voidPatchSha256: createHash('sha256').update(await readFile('patches/void@1.1.11.patch')).digest('hex') };
  await writeFile(join(output, 'verified.json'), JSON.stringify(verification, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { project, output, payload, verification };
}
