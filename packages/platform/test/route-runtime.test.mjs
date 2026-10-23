import test from 'node:test';
import assert from 'node:assert/strict';
import { routeRuntimeVerifier, backendRouteVerifier } from '../src/route-runtime.mjs';
import { routeController } from './fixtures/route-controller.mjs';

const id = '00000000-0000-4000-8000-000000000001', digest = 'b'.repeat(64), processSet = 'c'.repeat(64);
const selected = { id, digest };
function fixture() {
  const calls = [], slot = { id: 'slot-1', prefix: 'slots/one', nodes: ['a', 'b'] };
  const release = { id, digest, app: 'alpha', status: 'active', step: 'complete', secretRevision: null, version: 'native-version' };
  const controller = { baseDomain: 'localhost', slots: [slot], state: { apps: { alpha: { active: id, slot: slot.id, route: 'paused' } }, deployments: { [id]: release } },
    backend: { async owner(value) { calls.push(['owner', value.id]); return { app: 'alpha' }; } } };
  const identity = { async verify(value) { calls.push(['identity', value.id]); return processSet; } };
  const request = async (url, options) => {
    calls.push(['http', url]); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    if (url.endsWith(':8081/state')) return Response.json({ deployment: { version: release.version } });
    assert.ok(url.endsWith(':8080/.well-known/celld/health')); return new Response('{}');
  };
  return { controller, identity, request, calls, release, slot };
}
const verify = f => routeRuntimeVerifier(f.controller, f.identity, { request: f.request })('alpha', selected);
const refused = { code: 'ROUTE_RUNTIME_UNCONFIRMED', message: 'Approved HTTP runtime could not be verified' };

test('runtime verification brackets read-only version and health checks with signed process and owner checks', async () => {
  const f = fixture(), before = structuredClone(f.controller.state); await verify(f);
  assert.deepEqual(f.controller.state, before);
  assert.deepEqual(f.calls, [
    ['owner', 'slot-1'], ['identity', 'slot-1'],
    ['http', 'http://a:8081/state'], ['http', 'http://a:8080/.well-known/celld/health'], ['http', 'http://a:8081/state'],
    ['http', 'http://b:8081/state'], ['http', 'http://b:8080/.well-known/celld/health'], ['http', 'http://b:8081/state'],
    ['identity', 'slot-1'], ['owner', 'slot-1'],
  ]);
});
for (const [name, change] of [
  ['foreign approval', f => { f.release.digest = 'a'.repeat(64); }],
  ['unfinished approval', f => { f.release.step = 'publishing'; }],
  ['missing native version', f => { delete f.release.version; }],
  ['unbounded native version', f => { f.release.version = 'x'.repeat(513); }],
  ['quarantined app', f => { f.controller.state.apps.alpha.quarantined = true; }],
  ['uncertain migration', f => { f.controller.state.apps.alpha.uncertain = id; }],
  ['retired app', f => { f.controller.state.apps.alpha.retirement = {}; }],
  ['unfinished claim', f => { f.controller.state.apps.alpha.claim = {}; }],
  ['missing configured fleet', f => { f.controller.slots = []; }],
  ['single replica', f => { f.slot.nodes.pop(); }],
  ['third replica', f => { f.slot.nodes.push('c'); }],
  ['ambiguous fleet id', f => { f.controller.slots.push(structuredClone(f.slot)); }],
]) test(`${name} refuses before any backend observation`, async () => {
  const f = fixture(); change(f); await assert.rejects(verify(f), refused); assert.deepEqual(f.calls, []);
});
test('a nominal verifier without a verified process fingerprint cannot authorize HTTP', async () => {
  const f = fixture(); f.identity.verify = async () => undefined;
  await assert.rejects(verify(f), refused); assert.equal(f.calls.some(value => value[0] === 'http'), false);
});
for (const [name, change] of [
  ['foreign owner', f => { f.controller.backend.owner = async () => ({ app: 'beta' }); }],
  ['identity refusal', f => { f.identity.verify = async () => { throw new Error('PRIVATE proof'); }; }],
  ['version mismatch', f => { f.request = async () => Response.json({ deployment: { version: 'foreign' } }); }],
  ['health failure', f => { const read = f.request; f.request = async (url, options) => url.endsWith('/health') ? new Response('PRIVATE storage', { status: 507 }) : read(url, options); }],
  ['redirect', f => { f.request = async () => new Response(null, { status: 302 }); }],
  ['partial state', f => { f.request = async () => new Response('{}', { status: 206 }); }],
  ['absent state body', f => { f.request = async () => new Response(null); }],
  ['invalid state JSON', f => { f.request = async () => new Response('PRIVATE invalid JSON'); }],
  ['invalid state UTF-8', f => { f.request = async () => new Response(new Uint8Array([255])); }],
]) test(`${name} refuses without disclosing runtime details`, async () => {
  const f = fixture(); change(f); await assert.rejects(verify(f), refused);
});
for (const [name, change] of [
  ['process restart', f => { let reads = 0; f.identity.verify = async () => ++reads === 1 ? processSet : 'd'.repeat(64); }],
  ['owner change', f => { let reads = 0; f.controller.backend.owner = async () => ({ app: ++reads === 1 ? 'alpha' : 'beta' }); }],
  ['approval change', f => { const read = f.request; f.request = async (...args) => { const response = await read(...args); f.release.secretRevision = '00000000-0000-4000-8000-000000000002'; return response; }; }],
  ['version change after health', f => { const read = f.request; let reads = 0; f.request = async (...args) => { if (++reads === 3) return Response.json({ deployment: { version: 'replaced' } }); return read(...args); }; }],
]) test(`${name} during observation invalidates verification`, async () => {
  const f = fixture(); change(f); await assert.rejects(verify(f), refused);
});
test('a stalled HTTP read expires and aborts without accepting the runtime', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); let started, signal;
  const reading = new Promise(resolve => { started = resolve; });
  f.request = (_url, options) => { signal = options.signal; started(); return new Promise(() => {}); };
  const result = verify(f); await reading; t.mock.timers.tick(3000);
  await assert.rejects(result, refused); assert.equal(signal.aborted, true);
});
test('oversized native state is cancelled before draining the producer', async () => {
  const f = fixture(); let cancelled = false, pulls = 0;
  f.request = async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 ** 2)); if (pulls === 8) controller.close(); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(verify(f), refused); assert.equal(cancelled, true); assert.ok(pulls <= 6);
});
test('backend composition requires a separately valid installed runtime profile', () => {
  const f = fixture(); assert.throws(() => backendRouteVerifier(f.controller, {}), { code: 'RUNTIME_POLICY_REFUSED' });
  assert.deepEqual(f.calls, []);
});
test('controller resume keeps actual authority withheld when read-only runtime verification fails', async t => {
  const f = await routeController(t), release = await f.request(); await f.c.mutate(release.id, release.digest, 'approve');
  const input = { deployment: release.id, digest: release.digest };
  await f.c.decideRoute('alpha', 'pause', input);
  let controller; const identity = { verify: async () => processSet };
  let healthy = false, healthReads = 0;
  const request = async url => {
    if (url.endsWith('/health')) { healthReads++; return new Response('{}', { status: healthy ? 200 : 507 }); }
    return Response.json({ deployment: { version: release.version } });
  };
  controller = f.create({ routeAuthority: { ...f.routeAuthority, verifyRuntime: (...args) => routeRuntimeVerifier(controller, identity, { request })(...args) } });
  await controller.init(); const before = await f.public(), effects = [...f.events];
  await assert.rejects(controller.decideRoute('alpha', 'resume', input), /runtime identity\/readiness is unconfirmed/);
  assert.deepEqual((await f.public()).routes, before.routes); assert.deepEqual(f.events, effects); assert.equal(healthReads, 1);
  healthy = true; await controller.decideRoute('alpha', 'resume', input);
  assert.equal((await f.public()).routes[0].state, 'active'); assert.equal((await f.public()).routes[0].submission, release.id);
  assert.deepEqual(f.events, effects);
});

test('a stalled state body expires even if producer cancellation never finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); let started, cancelled = false;
  const reading = new Promise(resolve => { started = resolve; });
  f.request = async () => new Response(new ReadableStream({ start() { started(); }, cancel() { cancelled = true; return new Promise(() => {}); } }));
  const result = verify(f); await reading; t.mock.timers.tick(3000);
  await assert.rejects(result, refused); assert.equal(cancelled, true);
});
for (const bytes of [4 * 1024 ** 2, 4 * 1024 ** 2 + 1]) test(`the native-state bound ${bytes} is enforced on actual bytes`, async () => {
  const f = fixture(), read = f.request;
  const text = JSON.stringify({ deployment: { version: 'native-version' } }).padEnd(bytes, ' ');
  f.request = async (url, options) => url.endsWith('/state') ? new Response(text, { headers: { 'Content-Length': '1' } }) : read(url, options);
  if (bytes === 4 * 1024 ** 2) await verify(f); else await assert.rejects(verify(f), refused);
});

test('a response arriving after its deadline is cancelled and cannot authorize HTTP', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); let started, deliver, cancel;
  const reading = new Promise(resolve => { started = resolve; }), cancelled = new Promise(resolve => { cancel = resolve; });
  f.request = () => new Promise(resolve => { deliver = resolve; started(); });
  const result = verify(f); await reading; t.mock.timers.tick(3000); await assert.rejects(result, refused);
  deliver(new Response(new ReadableStream({ cancel })));
  await cancelled;
  assert.equal(f.calls.filter(value => value[0] === 'identity').length, 1);
});

test('a different submission with the same digest is not the selected completed approval', async () => {
  const f = fixture(), check = routeRuntimeVerifier(f.controller, f.identity, { request: f.request });
  await assert.rejects(check('alpha', { id: '00000000-0000-4000-8000-000000000002', digest }), refused);
  assert.deepEqual(f.calls, []);
});

for (const field of ['queueRecovery', 'cronRecovery']) test(`read-only verification can inspect ${field} without releasing its hold`, async () => {
  const f = fixture(), app = f.controller.state.apps.alpha;
  app[field] = { status: 'pending', id: 'retained-recovery' };
  const before = structuredClone(f.controller.state); await verify(f);
  assert.deepEqual(f.controller.state, before); assert.equal(app.route, 'paused');
});
