import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { controlScript } from '../src/admin-control-script.mjs';

function fixture(surface, action, accepted = true, ok = true) {
  const button = { dataset: { [surface]: action, app: 'refresh', deployment: 'approval', digest: 'digest', recovery: 'restore', review: 'findings' }, disabled: false };
  const calls = [], alerts = [];
  const context = {
    document: { querySelectorAll(selector) { assert.equal(selector, `button[data-${surface}]`); return [button]; } },
    confirm(prompt) { calls.push({ prompt }); return accepted; },
    async fetch(path, options) { calls.push({ path, options }); return { ok, async json() { return { error: 'unconfirmed' }; } }; },
    location: { reload() { calls.push('reload'); } }, alert(message) { alerts.push(message); },
  };
  const script = controlScript(surface, 'csrf-token', 'Reconcile application records?');
  runInNewContext(script.slice('<script>'.length, -'</script>'.length), context);
  return { button, calls, alerts };
}

test('queue and scheduled recovery buttons post their exact displayed findings only after explicit acceptance', async () => {
  for (const surface of ['delivery', 'dispatch']) {
    const f = fixture(surface, 'acknowledge-recovery'); await f.button.onclick();
    assert.equal(f.calls[0].prompt, 'Reconcile application records?');
    assert.equal(f.calls[1].path, `/v1/apps/refresh/${surface}/acknowledge-recovery`);
    assert.equal(f.calls[1].options.headers['X-Fogd-CSRF'], 'csrf-token');
    assert.deepEqual(JSON.parse(f.calls[1].options.body), { deployment: 'approval', digest: 'digest', recovery: 'restore', review: 'findings', acceptPossibleLoss: true });
    assert.equal(f.calls[2], 'reload');
    const denied = fixture(surface, 'acknowledge-recovery', false); await denied.button.onclick();
    assert.equal(denied.calls.length, 1); assert.equal(denied.button.disabled, false);
  }
});

test('ordinary controls omit recovery acceptance, and a failed action remains retryable', async () => {
  for (const surface of ['delivery', 'dispatch']) {
    const f = fixture(surface, 'pause', true, false); await f.button.onclick();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].path, `/v1/apps/refresh/${surface}/pause`);
    assert.deepEqual(JSON.parse(f.calls[0].options.body), { deployment: 'approval', digest: 'digest' });
    assert.deepEqual(f.alerts, ['unconfirmed']); assert.equal(f.button.disabled, false);
  }
});
