import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundSurfaces, assertBackgroundHeld } from './recovery-held-state.mjs';

function fixture() {
  const point = { approvals: { 'new-timer': {}, 'new-queue': {} }, manifest: {
    cronRecovery: { apps: { 'new-timer': { observation: { revision: 7 } } } },
    queueRecovery: { apps: { 'new-queue': { observation: { backlogCount: 1 } } } },
  }, sourceObservation: { 'new-queue': { queuePeek: { messages: [{ id: 'original', body: 'retained-input', attempts: 0 }] } } } };
  const observed = { 'new-timer': { status: { paused: true, nextAlarm: null, revision: 7 }, cronRecords: { wakes: [] } },
    'new-queue': { status: { paused: true, backlogCount: 1 }, queuePeek: { messages: [{ id: 'original', body: 'retained-input', attempts: 0 }] } } };
  return { point, observed };
}
test('held recovery follows the snapshot contracts for renamed cron and queue apps', () => {
  const { point, observed } = fixture(), surfaces = backgroundSurfaces(point);
  assert.deepEqual(surfaces, { 'new-timer': 'dispatch', 'new-queue': 'delivery' });
  assert.doesNotThrow(() => assertBackgroundHeld(observed, point, surfaces));
});
test('held recovery can observe only the surviving app', () => {
  const { point, observed } = fixture(), surfaces = backgroundSurfaces(point, { 'new-queue': {} });
  assert.deepEqual(surfaces, { 'new-queue': 'delivery' });
  assert.doesNotThrow(() => assertBackgroundHeld({ 'new-queue': observed['new-queue'] }, point, surfaces));
});
test('zero-live history has no live background recovery contracts', () => {
  const point = { approvals: {}, manifest: {} };
  assert.deepEqual(backgroundSurfaces(point), {});
  assert.doesNotThrow(() => assertBackgroundHeld({}, point, {}));
});
for (const [name, alter] of [
  ['missing snapshot contract', ({ point }) => { delete point.manifest.cronRecovery; }],
  ['ambiguous snapshot contract', ({ point }) => { point.manifest.queueRecovery.apps['new-timer'] = {}; }],
  ['running cron', ({ observed }) => { observed['new-timer'].status.paused = false; }],
  ['armed cron', ({ observed }) => { observed['new-timer'].status.nextAlarm = 100; }],
  ['changed revision', ({ observed }) => { observed['new-timer'].status.revision = 8; }],
  ['persisted cron wake', ({ observed }) => { observed['new-timer'].cronRecords.wakes.push({ due_ms: 100 }); }],
  ['running queue', ({ observed }) => { observed['new-queue'].status.paused = false; }],
  ['changed backlog', ({ observed }) => { observed['new-queue'].status.backlogCount = 0; }],
  ['changed queued body', ({ observed }) => { observed['new-queue'].queuePeek.messages[0].body = 'different-input'; }],
  ['attempted queued input', ({ observed }) => { observed['new-queue'].queuePeek.messages[0].attempts = 1; }],
]) test(`held recovery refuses ${name}`, () => {
  const value = fixture(); alter(value);
  assert.throws(() => assertBackgroundHeld(value.observed, value.point, backgroundSurfaces(value.point)), { code: 'ERR_ASSERTION' });
});
