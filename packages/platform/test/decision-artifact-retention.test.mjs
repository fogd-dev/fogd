import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { Controller } from '../src/controller.mjs';
import { planArtifactRetention } from '../src/artifact-retention.mjs';
import { decisionFixture } from './fixtures/decision-controller.mjs';

async function rejectedFixture(t) {
  const f = await decisionFixture(t), request = await f.submit(), http = await f.listen();
  assert.equal((await http.decide(request, 'reject')).status, 200);
  return { ...f, request, http, artifacts: join(f.controller.dir, 'artifacts') };
}

test('authenticated terminal decisions allow pruning while history and active apps survive reload', async t => {
  const f = await rejectedFixture(t), previous = await f.submit(), peer = await f.submit('peer');
  for (const request of [previous, peer]) assert.equal((await f.http.decide(request, 'approve')).status, 200);
  const current = await f.submit(); assert.equal((await f.http.decide(current, 'approve')).status, 200);
  const history = await (await f.http.get('/v1/admin/decisions')).json();
  const plan = await (await f.http.get('/v1/admin/artifacts')).json();
  const targets = [f.request.id, previous.id].sort();
  assert.deepEqual(plan.candidates.map(row => row.id).sort(), targets);
  assert.deepEqual(plan.protected.map(row => row.id).sort(), [current.id, peer.id].sort());
  const { csrf } = await (await f.http.get('/v1/admin')).json();
  const response = await fetch(f.http.origin + '/v1/admin/artifacts/prune', { method: 'POST', headers: {
    authorization: f.http.authorization, 'content-type': 'application/json', 'x-fogd-csrf': csrf,
  }, body: JSON.stringify({ plan: plan.plan }) });
  assert.equal(response.status, 200); const receipt = await response.json();
  assert.deepEqual(receipt.artifacts.map(row => row.id).sort(), targets);
  assert.equal(receipt.reclaimedArtifactBytes, plan.reclaimableArtifactBytes);
  for (const id of targets) await assert.rejects(access(join(f.artifacts, id)), { code: 'ENOENT' });
  const reloaded = new Controller(f.settings); await reloaded.init(); const http = await f.listen(reloaded);
  assert.deepEqual(await (await http.get('/v1/admin/decisions')).json(), history);
  for (const request of [f.request, previous]) {
    assert.equal((await http.get(`/v1/deployments/${request.id}/review`)).status, 410);
    assert.equal((await http.get(`/v1/deployments/${request.id}/artifact`)).status, 410);
  }
  for (const request of [current, peer]) {
    assert.equal((await http.get(`/v1/deployments/${request.id}/review`)).status, 200);
    assert.equal(reloaded.state.apps[request.app].active, request.id);
    await access(join(f.artifacts, request.id));
  }
});

for (const outcome of ['started', 'unconfirmed']) test(`${outcome} decisions retain terminal artifact bytes until uncertainty is resolved`, async t => {
  const f = await rejectedFixture(t), state = structuredClone(f.controller.state);
  Object.assign(state.decisions[0], { outcome, completedAt: null });
  const plan = await planArtifactRetention(state, f.artifacts);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.protected.map(row => [row.id, row.reasons]), [[f.request.id, ['controller-reference']]]);
});

test('finished decision history never overrides explicit pins or live recovery references', async t => {
  const f = await rejectedFixture(t);
  await f.controller.setArtifactPin(f.request.id, f.request.digest, true);
  const pinned = await planArtifactRetention(f.controller.state, f.artifacts);
  assert.deepEqual(pinned.candidates, []); assert.deepEqual(pinned.protected[0].reasons, ['operator-pin']);
  await f.controller.setArtifactPin(f.request.id, f.request.digest, false);
  const state = structuredClone(f.controller.state); state.recovery = { deployment: f.request.id };
  const held = await planArtifactRetention(state, f.artifacts);
  assert.deepEqual(held.candidates, []); assert.deepEqual(held.protected[0].reasons, ['controller-reference']);
});

test('malformed or missing decision history refuses retention planning before it can be excluded', async t => {
  const f = await rejectedFixture(t);
  for (const change of [state => { state.decisions = null; }, state => { delete state.decisions; },
    state => { state.decisions[0].digest = 'a'.repeat(64); }, state => { state.decisions[0].extra = true; },
    state => { state.requirements = []; }]) {
    const state = structuredClone(f.controller.state); change(state);
    await assert.rejects(planArtifactRetention(state, f.artifacts), /history/i);
  }
  await access(join(f.artifacts, f.request.id));
});
