// Run inside docker/verify.Dockerfile with --network none.
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { run, stackRoot } from '../packages/cli/src/local.mjs';
import { regularFiles, stageArtifact } from '../packages/runtime/src/artifact.mjs';

assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal),
  'Run the verification container with --network none');
const app = join(stackRoot, 'examples/guestbook');
const results = join(stackRoot, '.fogd/target-builds');
await mkdir(results, { recursive: true });

async function snapshot(target) {
  const dir = join(results, target);
  await cp(join(app, 'dist'), dir, { recursive: true });
  const config = JSON.parse(await readFile(join(dir, 'ssr/wrangler.json'), 'utf8'));
  const files = await Promise.all((await regularFiles(dir)).map(async path => ({ path, bytes: (await stat(join(dir, path))).size })));
  return { target, main: config.main, flags: config.compatibility_flags,
    assets: config.assets, d1: config.d1_databases?.map(db => db.binding), files };
}

await run('pnpm', ['--filter', '@fogd/example-guestbook', 'typecheck']);
await run('pnpm', ['--filter', '@fogd/example-guestbook', 'build']);
const managed = await snapshot('managed');
await run(process.execPath, ['scripts/build-app.mjs', 'examples/guestbook']);
const fogd = await snapshot('fogd');
assert.equal(fogd.files.filter(file => /^ssr\/.*\.[cm]?js$/.test(file.path)).length, 1);
const release = await stageArtifact({ projectDir: app, outputDir: join(results, 'staged'), app: 'guestbook' });
console.log('Offline artifact staged:', release.digest);
console.log('Offline target outputs (retained under .fogd/target-builds in the container):');
console.log(JSON.stringify({ managed, fogd }, null, 2));
