import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Backend } from '../src/backend.mjs';

test('D1 bootstrap provisions only database bindings without running scheduled app code', async t => {
  const artifact = await mkdtemp(join(tmpdir(), 'fogd-bootstrap-test-'));
  t.after(() => rm(artifact, { recursive: true, force: true }));
  const d1 = [{ binding: 'DB', database_name: 'refresh-db', database_id: 'refresh-db' }];
  await writeFile(join(artifact, 'wrangler.json'), JSON.stringify({
    name: 'refresh', main: 'app.js', compatibility_date: '2026-01-01',
    vars: { PRIVATE_TOKEN: 'must-not-be-in-bootstrap' },
    triggers: { crons: ['* * * * *'] },
    durable_objects: { bindings: [{ name: 'EFFECTS', class_name: 'Effects' }] },
    r2_buckets: [{ binding: 'FILES', bucket_name: 'private-files' }],
    queues: { consumers: [{ queue: 'arbitrary-consumer' }] },
  }));
  await writeFile(join(artifact, 'app.js'), "throw Error('user code must not load');\n");
  for (const fail of [false, true]) {
    const backend = Object.create(Backend.prototype);
    let publishedDirectory;
    backend.publish = async (slot, directory) => {
      assert.equal(slot.id, 'slot-1'); publishedDirectory = directory;
      const config = JSON.parse(await readFile(join(directory, 'wrangler.json'), 'utf8'));
      assert.deepEqual(config, { name: 'refresh', main: 'index.js', no_bundle: true,
        compatibility_date: '2026-01-01', d1_databases: d1 });
      const { default: worker } = await import(pathToFileURL(join(directory, 'index.js')).href);
      assert.deepEqual(Object.keys(worker), ['fetch']);
      assert.equal((await worker.fetch()).status, 503);
      if (fail) throw Error('publish response lost');
      return 'bootstrap-version';
    };
    const operation = backend.bootstrap({ id: 'slot-1' }, artifact, { script: 'refresh', d1 });
    if (fail) await assert.rejects(operation, /publish response lost/);
    else assert.equal(await operation, 'bootstrap-version');
    await assert.rejects(access(publishedDirectory), { code: 'ENOENT' });
  }
});
