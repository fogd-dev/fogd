import assert from 'node:assert/strict';

export function backgroundSurfaces(point, approvals = point.approvals) {
  return Object.fromEntries(Object.keys(approvals).map(name => {
    const cron = point.manifest.cronRecovery?.apps[name], queue = point.manifest.queueRecovery?.apps[name];
    assert.ok(Boolean(cron) !== Boolean(queue), 'Each observed background app needs exactly one snapshot contract');
    return [name, cron ? 'dispatch' : 'delivery'];
  }));
}

export function assertBackgroundHeld(observed, point, surfaces) {
  for (const [name, surface] of Object.entries(surfaces)) {
    assert.equal(observed[name].status.paused, true);
    if (surface === 'dispatch') {
      assert.equal(observed[name].status.nextAlarm, null);
      assert.equal(observed[name].status.revision, point.manifest.cronRecovery.apps[name].observation.revision);
      assert.deepEqual(observed[name].cronRecords.wakes, []);
    } else {
      assert.equal(observed[name].status.backlogCount, point.manifest.queueRecovery.apps[name].observation.backlogCount);
      assert.deepEqual(observed[name].queuePeek.messages, point.sourceObservation[name].queuePeek.messages);
    }
  }
}

export const backgroundRoute = surface => surface === 'dispatch' ? '/api/refresh' : '/api/imports';
