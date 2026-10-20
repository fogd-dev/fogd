// Run inside docker/verify.Dockerfile with --network none.
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { run, stackRoot } from '../packages/cli/src/local.mjs';
import { prepareGrowth } from './prepare-growth.mjs';
import { regularFiles, stageArtifact } from '../packages/runtime/src/artifact.mjs';

assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal),
  'Run the verification container with --network none');
const results = join(stackRoot, '.fogd/target-builds');
await mkdir(results, { recursive: true });

async function snapshot(app, target) {
  const dir = join(results, target);
  await cp(join(app, 'dist'), dir, { recursive: true });
  const config = JSON.parse(await readFile(join(dir, 'ssr/wrangler.json'), 'utf8'));
  const files = await Promise.all((await regularFiles(dir)).map(async path => ({ path, bytes: (await stat(join(dir, path))).size })));
  return { target, main: config.main, flags: config.compatibility_flags,
    assets: config.assets, queues: config.queues, triggers: config.triggers, secrets: config.secrets, d1: config.d1_databases?.map(db => db.binding), files };
}

async function verifyApp(app, label) {
  await run('pnpm', ['run', 'typecheck'], { cwd: app });
  await run('pnpm', ['run', 'build'], { cwd: app });
  const managed = await snapshot(app, `${label}-managed`);
  await run(process.execPath, ['scripts/build-app.mjs', app]);
  const fogd = await snapshot(app, `${label}-fogd`);
  assert.equal(fogd.files.filter(file => /^ssr\/.*\.[cm]?js$/.test(file.path)).length, 1);
  if (label === 'refresh') {
    assert.deepEqual(managed.triggers, { crons: ['* * * * *'] });
    assert.deepEqual(managed.triggers, fogd.triggers);
    assert.deepEqual(managed.secrets, { required: ['REFRESH_TOKEN'] });
    assert.deepEqual(managed.secrets, fogd.secrets);
    await assert.rejects(stageArtifact({ projectDir: app, outputDir: join(results, `${label}-rejected`), app: label }), /Unsupported binding\/config: triggers/);
    console.log(JSON.stringify({ managed, fogd, cronAdmission: 'closed' }, null, 2));
    return;
  }
  const release = await stageArtifact({ projectDir: app, outputDir: join(results, `${label}-staged`), app: label });
  assert.deepEqual(release.requiredSecrets, label === 'accounts' ? ['BETTER_AUTH_SECRET'] : []);
  if (label === 'imports') {
    assert.deepEqual(managed.queues, fogd.queues);
    assert.equal(managed.queues.producers[0].binding, 'QUEUE_IMPORTS');
    assert.equal(release.resources.queues.producers[0].queue, 'imports-imports');
  }
  console.log('Offline artifact staged:', release.digest);
  console.log(JSON.stringify({ managed, fogd }, null, 2));
}
await verifyApp(join(stackRoot, 'examples/guestbook'), 'guestbook');
const grown = await prepareGrowth(join(results, 'grown-source'));
await verifyApp(grown, 'grown');

await verifyApp(join(stackRoot, 'examples/accounts'), 'accounts');

await verifyApp(join(stackRoot, 'examples/imports'), 'imports');

await verifyApp(join(stackRoot, 'examples/checklist'), 'checklist');
await verifyApp(join(stackRoot, 'examples/refresh'), 'refresh');
