import test from 'node:test';
import assert from 'node:assert/strict';
import { translateConfig, inside } from '../src/artifact.mjs';

test('configuration translation rejects nonobjects and multiple databases before staging', () => {
  for (const input of [null, [], 'private-input']) assert.throws(() => translateConfig(input, 'hello'), /configuration object/);
  assert.throws(() => translateConfig({ d1_databases: [{ binding: 'FIRST' }, { binding: 'SECOND' }] }, 'hello'), /one D1 database/);
});

test('rejects requested unsupported bindings instead of silently dropping them', () => {
  for (const key of ['ai', 'dispatch_namespaces', 'hyperdrive', 'services', 'triggers']) {
    assert.throws(() => translateConfig({ [key]: { binding: 'secret' } }, 'hello'), /Unsupported/);
  }
  assert.throws(() => translateConfig({ compatibility_flags: ['future_flag'] }, 'hello'), /flag/);
});
test('translates generated metadata while keeping resource identities stable', () => {
  const input = { name: 'build-name', no_bundle: true, rules: [{ type: 'ESModule' }], d1_databases: [{ binding: 'DB', database_id: 'local' }], r2_buckets: [{ binding: 'STORAGE' }], dispatch_namespaces: [], queues: { producers: [], consumers: [] } };
  const output = translateConfig(input, 'hello');
  assert.equal(output.name, 'hello');
  assert.equal(output.no_bundle, true);
  assert.equal(output.d1_databases[0].database_id, 'hello-db');
  assert.equal(output.r2_buckets[0].bucket_name, 'hello-storage');
  assert.equal(output.rules, undefined);
  assert.deepEqual(output, translateConfig({ ...input, name: 'another-build-name' }, 'hello'));
});
test('rejects paths outside the artifact/project and invalid app names', () => {
  assert.throws(() => inside('/project', '../secret'));
  assert.throws(() => inside('/project', '/secret'));
  assert.throws(() => translateConfig({}, '../app'));
  assert.equal(inside('/project', 'dist/ssr'), '/project/dist/ssr');
});

import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageArtifact, artifactDigest, regularFiles } from '../src/artifact.mjs';

test('stages the exact application SQL list and produces a content digest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fogd-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist/ssr'), { recursive: true });
  await mkdir(join(root, 'db/migrations'), { recursive: true });
  await mkdir(join(root, 'dist/client/nested'), { recursive: true });
  for (const name of ['main.js', 'wrangler.json', '.dev.vars', '.dev.vars.local', '.env', '.env.local', '_headers', '_redirects', 'nested/private.txt', 'nested/public.txt', 'nested/.env', 'nested/.dev.vars']) {
    await writeFile(join(root, 'dist/client', name), 'fixture');
  }
  await writeFile(join(root, 'dist/client/.assetsignore'), '!.*\n!nested/.*\nwrangler.json\nnested/*.txt\n!nested/public.txt\n_headers\n_redirects\n');
  for (const name of ['.dev.vars', '.dev.vars.local', '.env', 'index.js.map']) {
    await writeFile(join(root, 'dist/ssr', name), 'private-preview-secret');
  }
  await writeFile(join(root, 'dist/ssr/math.wasm'), 'wasm-fixture');
  await writeFile(join(root, 'dist/ssr/index.js'), 'export default {fetch(){return new Response("ok")}}');
  await writeFile(join(root, 'dist/ssr/wrangler.json'), JSON.stringify({ main: 'index.js', d1_databases: [{ binding: 'DB' }], assets: { directory: '../client' } }));
  await writeFile(join(root, 'db/migrations/0001_init.sql'), 'CREATE TABLE entries(id TEXT PRIMARY KEY);');
  await writeFile(join(root, 'db/migrations/seed.sql'), 'INSERT INTO entries VALUES ("seed");');
  const release = await stageArtifact({ projectDir: root, outputDir: join(root, 'release'), app: 'test' });
  assert.equal(release.migrations.length, 1);
  assert.equal(release.migrations[0].name, '0001_init.sql');
  assert.equal(release.digest, await artifactDigest(join(root, 'release')));
  assert.deepEqual(await regularFiles(join(root, 'release/worker')), ['index.js', 'math.wasm']);
  assert.deepEqual(await regularFiles(join(root, 'release/assets')), ['_headers', '_redirects', 'main.js', 'nested/public.txt']);
  await writeFile(join(root, 'release/worker/index.js'), 'tampered');
  assert.notEqual(release.digest, await artifactDigest(join(root, 'release')));
  await assert.rejects(stageArtifact({ projectDir: root, outputDir: join(root, 'release'), app: 'test' }), /EEXIST/);
});

test('refuses split modules and symlinked build files before publication', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fogd-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist/ssr'), { recursive: true });
  await writeFile(join(root, 'dist/ssr/index.js'), 'import "./chunk.js";');
  await writeFile(join(root, 'dist/ssr/chunk.js'), 'export const n = 1;');
  await assert.rejects(stageArtifact({ projectDir: root, outputDir: join(root, 'release'), app: 'test' }), /single JavaScript/);
  await rm(join(root, 'dist/ssr/chunk.js'));
  await symlink('/etc/passwd', join(root, 'dist/ssr/secret'));
  await assert.rejects(stageArtifact({ projectDir: root, outputDir: join(root, 'release'), app: 'test' }), /Symlinks/);
});

test('rejects unusable resource names and unsupported nested settings before reservation', () => {
  for (const key of ['r2_buckets', 'd1_databases']) {
    assert.throws(() => translateConfig({ [key]: [{ binding: 'STORAGE' }] }, 'a'.repeat(63)), /64 characters/);
    assert.throws(() => translateConfig({ [key]: [{ binding: 'STORAGE', jurisdiction: 'eu' }] }, 'hello'), /Unsupported/);
  }
});


test('queue bindings participate in the shared binding namespace', () => {
  const queues = { producers: [{ binding: 'JOBS', queue: 'jobs' }], consumers: [{ queue: 'jobs', max_batch_size: 1, max_batch_timeout: 1, max_retries: 1, retry_delay: 1 }] };
  assert.throws(() => translateConfig({ queues, vars: { jobs: 'collision' } }, 'demo'), /Duplicate binding/);
  assert.throws(() => translateConfig({ queues, d1_databases: [{ binding: 'JOBS' }] }, 'demo'), /Duplicate binding/);
});
