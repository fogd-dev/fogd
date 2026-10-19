import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChecklistObserver } from '../lib/observer.mjs';
const snapshot = revision => ({ type: 'snapshot', release: 'v1', revision, items: [] });
const control = (ok = true) => Response.json({ accepted: true, results: [{ ok, kind: 'subscribe', id: 'board', topic: 'shared' }] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('registration precedes initial and reconnect snapshots, repairing a missed hint', async () => {
  let revision = 1, reads = 0;
  const model = new ChecklistObserver(async () => { reads++; return snapshot(revision); }, () => {}, 'shared');
  await model.refresh(); assert.equal(reads, 0);
  await model.control(control(false), 0); assert.equal(reads, 0);
  assert.equal(model.view.status, 'Not subscribed');
  await model.control(control(), model.epoch); assert.equal(model.view.revision, 1);
  model.disconnected(); revision = 3;
  await model.refresh(); assert.equal(reads, 1);
  await model.control(control(), model.epoch); assert.equal(model.view.revision, 3);
});

test('late reads cannot overwrite a newer snapshot or reconnect generation', async () => {
  const requests = [];
  const model = new ChecklistObserver(() => { const d = deferred(); requests.push(d); return d.promise; }, () => {}, 'shared');
  const first = model.control(control(), 0);
  await new Promise(r => setImmediate(r)); requests[0].resolve(snapshot(1)); await first;
  const slow = model.refresh(), fast = model.refresh();
  requests[2].resolve(snapshot(3)); await fast;
  requests[1].resolve(snapshot(2)); await slow; assert.equal(model.view.revision, 3);
  const obsolete = model.refresh(); model.disconnected();
  const current = model.control(control(), model.epoch);
  await new Promise(r => setImmediate(r)); requests[4].resolve(snapshot(4)); await current;
  requests[3].resolve(snapshot(99)); await obsolete; assert.equal(model.view.revision, 4);
});

test('stale registration does not synchronize and lower restored state requires reload', async () => {
  let revision = 5;
  const model = new ChecklistObserver(async () => snapshot(revision), () => {}, 'shared');
  await model.control(control(), 0); model.disconnected();
  revision = 2; await model.control(control(), 0); assert.equal(model.registered, false);
  await model.control(control(), model.epoch);
  assert.equal(model.view.restored, true); assert.equal(model.view.revision, 5);
  model.close(); await model.control(control(), model.epoch); assert.equal(model.view.revision, 5);
});
