// Ordinary Void and fogd builds in the pinned SDK image, with networking absent.
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildArtifact, run, stackRoot } from '../../../packages/cli/src/local.mjs';
import { artifactDigest } from '../../../packages/runtime/src/artifact.mjs';
import { offlineSourceHashes, copyOfflineProject, readableOfflineOutput } from '../offline-project.mjs';
import { manifest } from '../../../packages/runtime/src/manifest.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal));
assert.equal(stackRoot, '/results/home');
assert.ok(!Object.keys(process.env).some(key => /^(AWS_|MINIO_|CLOUDFLARE_|CF_)/i.test(key) || /^FOGD_.*(TOKEN|PASSWORD|SECRET)/i.test(key)));
const capabilities = JSON.parse(await readFile('/source/capabilities.json', 'utf8'));
assert.deepEqual(capabilities, { cronApps: true });
const source = '/source/project', output = '/results';
let failure;
try {
  const before = await offlineSourceHashes(source), managedProject = await copyOfflineProject(source, '/app/.fogd/ordinary-managed-refresh');
  assert.deepEqual(await offlineSourceHashes(managedProject), before);
  await run('pnpm', ['run', 'typecheck'], { cwd: managedProject });
  await run('pnpm', ['run', 'build'], { cwd: managedProject });
  assert.deepEqual(await offlineSourceHashes(managedProject), before);
  const managed = JSON.parse(await readFile(join(managedProject, 'dist/ssr/wrangler.json'), 'utf8'));
  await preserveGenerated(managedProject, 'managed-generated');
  await cp(join(managedProject, 'dist'), join(output, 'managed'), { recursive: true });
  const fogdProject = await copyOfflineProject(source, '/app/.fogd/ordinary-fogd-refresh');
  assert.deepEqual(await offlineSourceHashes(fogdProject), before);
  const release = await buildArtifact(fogdProject, 'refresh', capabilities);
  assert.deepEqual(await offlineSourceHashes(fogdProject), before);
  await preserveGenerated(fogdProject, 'fogd-generated');
  const generated = JSON.parse(await readFile(join(fogdProject, 'dist/ssr/wrangler.json'), 'utf8'));
  await cp(release.outputDir, join(output, 'artifact'), { recursive: true });
  assert.equal(await artifactDigest(join(output, 'artifact')), release.digest);
  const native = JSON.parse(await readFile(join(output, 'artifact/wrangler.json'), 'utf8'));
  assert.ok(['* * * * *', '*/3 * * * *'].includes(managed.triggers.crons[0]));
  assert.equal(managed.triggers.crons.length, 1); assert.deepEqual(generated.triggers, managed.triggers); assert.deepEqual(native.triggers, managed.triggers);
  assert.deepEqual(managed.secrets, { required: ['REFRESH_TOKEN'] }); assert.deepEqual(generated.secrets, managed.secrets);
  assert.deepEqual(managed.d1_databases.map(value => value.binding), generated.d1_databases.map(value => value.binding));
  assert.deepEqual(release.requiredSecrets, ['REFRESH_TOKEN']);
  assert.deepEqual(await offlineSourceHashes(source), before);
  await writeFile(join(output, 'manifest.json'), JSON.stringify(await manifest(join(output, 'artifact'), release)) + '\n');
  await writeFile(join(output, 'fogd-generated-wrangler.json'), JSON.stringify(generated, null, 2) + '\n');
  await writeFile(join(output, 'offline.json'), JSON.stringify({ network: 'none', sourceFiles: before, capabilities,
    managed, fogdGenerated: generated, native, release: { app: release.app, digest: release.digest, resources: release.resources, migrations: release.migrations, requiredSecrets: release.requiredSecrets },
    ordinaryBuildApi: 'buildArtifact', capabilitiesSha256: hash(await readFile('/source/capabilities.json')) }, null, 2) + '\n');
} catch (error) { failure = error; throw error; }
finally {
  try { await readableOfflineOutput(output, { directory: 0o700, file: 0o600 }); }
  catch (error) { throw failure ? new AggregateError([failure, error], 'Offline build and output permissions failed') : error; }
}

async function preserveGenerated(project, name) {
  await cp(join(project, '.void'), join(output, name, '.void'), { recursive: true, filter: path => !path.endsWith('/dev-trigger-token') });
  await cp(join(project, '.void-wrangler.jsonc'), join(output, name, '.void-wrangler.jsonc'));
}
