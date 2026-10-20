import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCronState } from '../src/cron-activation.mjs';

function state() {
  return { requirements: ['fogd-cron-activation-v1'],
    apps: { refresh: { resources: { script: 'refresh', crons: ['* * * * *'] }, active: null, uncertain: null,
      dispatch: { schema: 1, script: 'refresh', desired: 'running', hold: 'approval', version: null, observed: 'unknown', observedAt: null, operation: null },
      cronBootstrap: { phase: 'ready', version: 'bootstrap' } } },
    deployments: { approval: { id: 'approval', app: 'refresh', status: 'failed', secretRevision: null, resources: { script: 'refresh', crons: ['* * * * *'] } } } };
}
const runtime = { pause() {}, resume() {}, status() {} };

test('cron restart rejects mismatched identities, invalid approvals and incomplete bootstrap metadata', () => {
  for (const mutate of [
    s => { s.apps.refresh.dispatch.script = 'other'; },
    s => { s.apps.refresh.resources.script = 'other'; },
    s => { s.apps.refresh.dispatch.hold = 'unknown'; },
    s => { s.deployments.approval.status = 'pending'; },
    s => { delete s.deployments.approval.secretRevision; },
    s => { s.deployments.approval.app = 'other'; },
    s => { delete s.deployments.approval.resources.crons; },
    s => { s.deployments.approval.id = 'different-approval'; },
    s => { s.apps.refresh.dispatch.hold = null; s.apps.refresh.dispatch.version = 'unapproved'; },
    s => { s.apps.refresh.cronBootstrap.phase = 'unknown'; },
    s => { delete s.apps.refresh.cronBootstrap.version; },
    s => { s.apps.refresh.uncertain = 'another-attempt'; },
    s => { s.apps.refresh.dispatch.futureFlag = true; },
  ]) {
    const input = state(); mutate(input);
    assert.throws(() => validateCronState(input, runtime), /Cron|cron|Uncertain|Unknown/);
  }
});

test('cron restart accepts an unheld release only when an approved version matches', () => {
  const input = state();
  input.apps.refresh.dispatch.hold = null; input.apps.refresh.dispatch.version = 'approved';
  input.apps.refresh.cronBootstrap = { phase: 'application' };
  input.deployments.approval.status = 'active'; input.deployments.approval.version = 'approved';
  assert.doesNotThrow(() => validateCronState(input, runtime));
  input.apps.refresh.dispatch.version = 'other';
  assert.throws(() => validateCronState(input, runtime), /no matching approved application version/);
  input.apps.refresh.dispatch.version = 'approved';
  input.deployments.approval.status = 'pending';
  assert.throws(() => validateCronState(input, runtime), /no matching approved application version/);
});
