import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Delivery, initialDelivery } from '../src/delivery.mjs';
import { readJson, saveJson } from '../src/store.mjs';

test('SIGKILL at journal boundaries never auto-resumes and explicit retry uses the persisted version', async t => {
  for (const point of ['before-effect', 'after-effect', 'after-confirmation']) {
    const dir = await mkdtemp(join(tmpdir(), 'fogd-delivery-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const journal = join(dir, 'delivery.json'), effect = join(dir, 'runtime.json');
    await saveJson(journal, { ...initialDelivery('imports', 'first'), hold: null, version: 'v1', desired: 'paused' });
    await saveJson(effect, { paused: true, version: 'v1' });
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/delivery-crash.mjs', import.meta.url)), dir, point], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const saved = await readJson(journal), actual = await readJson(effect);
    assert.equal(saved.desired, 'running');
    assert.equal(saved.version, 'v1');
    assert.equal(saved.observed, point === 'after-confirmation' ? 'running' : 'unknown');
    assert.equal(saved.operation, point === 'after-confirmation' ? null : 'resume');
    assert.equal(actual.paused, point === 'before-effect');
    const calls = [];
    const d = new Delivery({ state: saved, slot: {}, persist: state => saveJson(journal, state), runtime: {
      async resume(_slot, name, version) { calls.push({ name, version }); await saveJson(effect, { paused: false, version }); return { paused: false }; },
    } });
    assert.deepEqual(calls, []);
    assert.deepEqual(await readJson(effect), actual);
    await d.reconcile();
    assert.deepEqual(calls, [{ name: 'imports', version: 'v1' }]);
    assert.equal((await readJson(journal)).observed, 'running');
  }
});
test('activation-release crashes preserve the hold until confirmed, while interrupted observe loses stale knowledge', async t => {
  for (const point of ['before-effect', 'after-effect', 'after-confirmation', 'observe']) {
    const dir = await mkdtemp(join(tmpdir(), 'fogd-activation-delivery-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const journal = join(dir, 'delivery.json'), effect = join(dir, 'runtime.json');
    await saveJson(journal, { ...initialDelivery('imports', 'first'), observed: 'paused', observedAt: new Date().toISOString() });
    await saveJson(effect, { paused: true, version: 'v1' });
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/delivery-crash.mjs', import.meta.url)), dir, point, 'activation'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const saved = await readJson(journal), completed = point === 'after-confirmation';
    assert.equal((await readJson(effect)).paused, point === 'before-effect' || point === 'observe');
    assert.equal(saved.hold, completed ? null : 'first');
    assert.equal(saved.observed, completed ? 'running' : 'unknown');
    const calls = [];
    const d = new Delivery({ state: saved, slot: {}, persist: state => saveJson(journal, state), runtime: {
      async pause() { calls.push('pause'); await saveJson(effect, { paused: true }); return { paused: true }; },
      async resume() { calls.push('resume'); await saveJson(effect, { paused: false }); return { paused: false }; },
    } });
    assert.deepEqual(calls, []);
    await d.reconcile();
    assert.deepEqual(calls, [completed ? 'resume' : 'pause']);
    assert.equal((await readJson(effect)).paused, !completed);
    if (!completed) {
      assert.equal(d.state.hold, 'first');
      await d.completeActivation('first', 'v1');
      assert.equal(d.state.hold, null);
    }
  }
});
