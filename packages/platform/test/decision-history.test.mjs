import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Controller } from '../src/controller.mjs';
import { saveJson } from '../src/store.mjs';
import { decisionReviewToken, decisionHistory, validateDecisionHistory, decisionHistoryCapability } from '../src/decision-history.mjs';
import { decisionFixture } from './fixtures/decision-controller.mjs';

const context = { actor: { kind: 'basic', name: 'operator' } };
const disk = controller => readFile(join(controller.dir, 'state.json'), 'utf8').then(JSON.parse);

test('authenticated decisions persist intent before effects and retain the actual credential across restart', async t => {
  const f = await decisionFixture(t), request = await f.submit(), http = await f.listen();
  let observed;
  f.onPublish(async () => { observed = (await disk(f.controller)).decisions.at(-1); });
  const response = await http.decide(request, 'approve', { actor: { kind: 'basic', name: 'forged-person' } });
  assert.equal(response.status, 200); assert.equal(observed.outcome, 'started'); assert.equal(observed.actor.name, 'ops<&>');
  const entry = (await disk(f.controller)).decisions.at(-1);
  assert.equal(entry.outcome, 'succeeded'); assert.equal(entry.applicationStatus, 'active'); assert.equal(entry.deployment, request.id);
  assert.equal(entry.digest, request.digest); assert.deepEqual(entry.actor, { kind: 'basic', name: 'ops<&>' });
  assert.ok(entry.completedAt); assert.ok(f.controller.state.requirements.includes(decisionHistoryCapability));
  const reloaded = new Controller(f.settings); await reloaded.init();
  const fresh = await f.listen(reloaded), history = await (await fresh.get('/v1/admin/decisions')).json();
  assert.deepEqual(history.entries, [entry]); assert.match(history.principalNotice, /Shared credentials/);
  assert.ok(!JSON.stringify(history).includes('private-'));
});

test('rejection is attributed without activation and history is authenticated and HTML-escaped', async t => {
  const f = await decisionFixture(t), request = await f.submit(), http = await f.listen();
  assert.equal((await http.get('/v1/admin/decisions', null)).status, 401);
  assert.equal((await http.decide(request, 'reject')).status, 200); assert.deepEqual(f.effects, []);
  const entry = (await (await http.get('/v1/admin/decisions')).json()).entries[0];
  assert.equal(entry.action, 'reject'); assert.equal(entry.outcome, 'succeeded'); assert.equal(entry.applicationStatus, 'rejected');
  const response = await http.get('/admin/decisions'), page = await response.text();
  assert.match(page, /ops&lt;&amp;&gt;/); assert.ok(!page.includes('ops<&>')); assert.ok(!page.includes('private-'));
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await (await http.get('/v1/admin')).json()).decisionHistory.count, 1);
  assert.equal((await http.get('/v1/admin/decisions?before=private-invalid')).status, 400);
});

test('activation failure has a distinct durable outcome without raw private diagnostics', async t => {
  const f = await decisionFixture(t), request = await f.submit(), http = await f.listen();
  f.onPublish(() => { throw Error('private-runtime-diagnostic'); });
  assert.equal((await http.decide(request, 'approve')).status, 200);
  const history = await (await http.get('/v1/admin/decisions')).json();
  assert.equal(history.entries[0].outcome, 'activation-failed'); assert.equal(history.entries[0].applicationStatus, 'failed');
  assert.ok(!JSON.stringify(history).includes('private-'));
});

test('stale same-app review context refuses before effects and records a refused decision', async t => {
  const f = await decisionFixture(t), first = await f.submit(), next = await f.submit(), http = await f.listen();
  const review = decisionReviewToken(f.controller, next.id);
  assert.equal((await http.decide(first, 'approve')).status, 200);
  const before = f.effects.length;
  const response = await http.decide(next, 'approve', { review });
  assert.equal(response.status, 409); assert.equal(f.effects.length, before); assert.equal(next.status, 'superseded');
  const entry = (await disk(f.controller)).decisions.at(-1); assert.equal(entry.outcome, 'refused'); assert.equal(entry.review, review);
});

test('another app decision does not invalidate the selected app review context', async t => {
  const f = await decisionFixture(t), first = await f.submit('first'), second = await f.submit('second'), http = await f.listen();
  const review = decisionReviewToken(f.controller, first.id);
  assert.equal((await http.decide(second, 'approve')).status, 200);
  assert.equal(decisionReviewToken(f.controller, first.id), review);
  assert.equal((await http.decide(first, 'approve', { review })).status, 200);
  const selected = await (await http.get('/v1/admin/decisions?app=first')).json();
  assert.equal(selected.entries.length, 1); assert.equal(selected.entries[0].deployment, first.id);
});

for (const afterWrite of [false, true]) test(`failed intent persistence stops all effects and survives reload: committed=${afterWrite}`, async t => {
  let armed = false;
  const f = await decisionFixture(t, { persist: async (path, value) => {
    if (armed && value.decisions?.at(-1)?.outcome === 'started') {
      if (afterWrite) await saveJson(path, value);
      throw Object.assign(Error('private-intent-write'), { code: 'EIO' });
    }
    await saveJson(path, value);
  } });
  const request = await f.submit(); armed = true;
  await assert.rejects(f.controller.mutate(request.id, request.digest, 'approve', undefined, undefined, context), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
  assert.deepEqual(f.effects, []); armed = false;
  const recovered = new Controller(f.settings); await recovered.init();
  assert.equal(recovered.state.deployments[request.id].status, 'pending');
  assert.equal(recovered.state.decisions?.[0]?.outcome, afterWrite ? 'unconfirmed' : undefined);
  assert.deepEqual(f.effects, []);
});

test('lost final outcome never replays a successful activation and stays unconfirmed after reload', async t => {
  let armed = false;
  const f = await decisionFixture(t, { persist: async (path, value) => {
    if (armed && value.decisions?.at(-1)?.outcome === 'succeeded') throw Error('private-final-write');
    await saveJson(path, value);
  } });
  const request = await f.submit(); armed = true;
  await assert.rejects(f.controller.mutate(request.id, request.digest, 'approve', undefined, undefined, context), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
  assert.equal((await disk(f.controller)).decisions[0].outcome, 'started');
  const effects = f.effects.length; assert.ok(effects > 0); armed = false;
  const recovered = new Controller(f.settings); await recovered.init();
  assert.equal(recovered.state.apps.demo.active, request.id); assert.equal(recovered.state.decisions[0].outcome, 'unconfirmed');
  assert.equal(f.effects.length, effects);
});

test('history corruption or missing capability refuses startup validation', async t => {
  const f = await decisionFixture(t), request = await f.submit();
  await f.controller.mutate(request.id, request.digest, 'reject', undefined, undefined, context);
  for (const change of [state => { state.requirements = []; }, state => { state.decisions.push(state.decisions[0]); },
    state => { state.decisions[0].digest = 'a'.repeat(64); }, state => { state.decisions[0].actor.name = 'private\nname'; },
    state => { state.decisions[0].app = {}; }, state => { state.decisions[0].private = 'private-extra'; }, state => { delete state.decisions; }]) {
    const state = structuredClone(f.controller.state); change(state); assert.throws(() => validateDecisionHistory(state), /history/);
  }
});

test('history pagination keeps app filters and stable exclusive cursors without returning mutable records', () => {
  const entries = Array.from({ length: 205 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, app: index % 2 ? 'other' : 'demo' }));
  const controller = { state: { decisions: entries } }, first = decisionHistory(controller, { app: 'demo' });
  assert.equal(first.entries.length, 100); assert.equal(first.entries[0].id, entries[204].id);
  const second = decisionHistory(controller, { app: 'demo', before: first.next });
  assert.deepEqual(second.entries.map(entry => entry.id), [entries[4].id, entries[2].id, entries[0].id]);
  first.entries[0].app = 'changed'; assert.equal(entries[204].app, 'demo');
  assert.throws(() => decisionHistory(controller, { before: 'private-invalid' }), /selection/);
});

test('a refused non-retryable decision is distinct from an unconfirmed effect and bad CSRF records nothing', async t => {
  const f = await decisionFixture(t), request = await f.submit(), http = await f.listen();
  assert.equal((await http.decide(request, 'approve')).status, 200);
  assert.equal((await http.decide(request, 'approve')).status, 400);
  assert.equal(f.controller.state.decisions.at(-1).outcome, 'refused');
  const count = f.controller.state.decisions.length;
  const response = await fetch(`${http.origin}/v1/deployments/${request.id}/reject`, { method: 'POST', headers: { authorization: http.authorization, 'content-type': 'application/json' }, body: JSON.stringify({ digest: request.digest }) });
  assert.equal(response.status, 403); assert.equal(f.controller.state.decisions.length, count);
});

test('an invalid deployment checkpoint cannot create a malformed durable history row', async t => {
  const f = await decisionFixture(t), request = await f.submit(), http = await f.listen();
  request.status = 'invalid-checkpoint';
  assert.equal((await http.decide(request, 'approve')).status, 400);
  assert.equal(f.controller.state.decisions, undefined);
  assert.equal((await disk(f.controller)).decisions, undefined);
  assert.deepEqual(f.effects, []);
});


test('retired deployment refusals remain valid history across restart', async t => {
  const f = await decisionFixture(t), request = await f.submit(), http = await f.listen();
  request.status = 'retired';
  assert.equal((await http.decide(request, 'approve')).status, 400);
  const entry = f.controller.state.decisions[0];
  assert.equal(entry.outcome, 'refused'); assert.equal(entry.applicationStatus, 'retired');
  validateDecisionHistory(f.controller.state);
  const reloaded = new Controller(f.settings); await reloaded.init();
  assert.deepEqual(reloaded.state.decisions, [entry]); assert.deepEqual(f.effects, []);
});

test('a review from a prior controller instance is refused after reload without exposing private context', async t => {
  const f = await decisionFixture(t), request = await f.submit();
  const review = decisionReviewToken(f.controller, request.id);
  const reloaded = new Controller(f.settings); await reloaded.init();
  const http = await f.listen(reloaded);
  assert.equal((await http.decide(request, 'approve', { review })).status, 409);
  assert.deepEqual(f.effects, []); assert.equal(reloaded.state.decisions[0].outcome, 'refused');
});
