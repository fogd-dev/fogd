import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { observeServing, summarizeRequests } from '../../../scripts/capacity/serving-observer.mjs';
import { reconcileWrites } from '../../../scripts/capacity/write-ledger.mjs';

async function server(t, respond) {
  const received = [], instance = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ method: req.method, path: req.url, host: req.headers.host, body });
    respond(req, res, body);
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return { received, settings: { targets: { direct: '127.0.0.1' }, port: instance.address().port } };
}
test('default read sampler still checks complete response bytes over real HTTP', async t => {
  const body = '[{"id":1}]', f = await server(t, (_, res) => res.end(body));
  const good = await observeServing({ ...f.settings, bodySha256: createHash('sha256').update(body).digest('hex') }, 'direct');
  const wrong = await observeServing({ ...f.settings, bodySha256: 'a'.repeat(64) }, 'direct');
  assert.equal(good.correct, true); assert.equal(good.status, 200); assert.ok(good.finishedMs >= good.startedMs);
  assert.equal(wrong.correct, false); assert.equal(Object.hasOwn(good, 'writeId'), false);
  assert.deepEqual(f.received.map(v => [v.method, v.path]), [['GET', '/api/messages'], ['GET', '/api/messages']]);
});
test('acknowledged and post-commit error writes reconcile without replaying mutations', async t => {
  const rows = [], f = await server(t, (_, res, raw) => {
    const { id } = JSON.parse(raw); rows.push({ id, app: 'baseline' });
    res.statusCode = id === 'second' ? 502 : 200; res.end(JSON.stringify(id === 'second' ? { error: 'after commit' } : { id, app: 'baseline' }));
  });
  const settings = { ...f.settings, workload: 'writes' }, samples = [];
  for (const id of ['first', 'second']) samples.push(await observeServing(settings, 'direct', id));
  assert.deepEqual(f.received.map(v => [v.method, v.path, JSON.parse(v.body).id]), [['POST', '/api/write-probe', 'first'], ['POST', '/api/write-probe', 'second']]);
  assert.deepEqual(samples.map(v => [v.writeId, v.status, v.correct]), [['first', 200, true], ['second', 502, false]]);
  assert.equal(summarizeRequests(samples).errors, 1);
  assert.deepEqual(reconcileWrites(samples, rows), { attempts: 2, committed: 2, acknowledged: 1, acknowledgedMissing: [], unacknowledgedCommitted: [{ writeId: 'second', status: 502 }], unacknowledgedAbsent: [] });
});
test('connection loss after commit remains visible and never resends its operation', async t => {
  const rows = [], f = await server(t, (req, _, raw) => { rows.push({ id: JSON.parse(raw).id, app: 'baseline' }); req.socket.destroy(); });
  const sample = await observeServing({ ...f.settings, workload: 'writes' }, 'direct', 'lost-ack');
  assert.equal(f.received.length, 1); assert.equal(sample.status, 0); assert.equal(sample.correct, false);
  assert.deepEqual(reconcileWrites([sample], rows).unacknowledgedCommitted, [{ writeId: 'lost-ack', status: 0 }]);
});
for (const value of [{ id: 'other', app: 'baseline' }, { id: 'operation', app: 'peer' }, null]) test(`HTTP 200 cannot acknowledge the wrong operation: ${JSON.stringify(value)}`, async t => {
  const f = await server(t, (_, res) => res.end(JSON.stringify(value)));
  const sample = await observeServing({ ...f.settings, workload: 'writes' }, 'direct', 'operation');
  assert.equal(sample.status, 200); assert.equal(sample.correct, false); assert.equal(summarizeRequests([sample]).errors, 1);
});
test('a redirect response is retained without following or replaying it', async t => {
  const f = await server(t, (_, res) => { res.writeHead(307, { Location: '/another-app' }); res.end(); });
  const sample = await observeServing({ ...f.settings, workload: 'writes' }, 'direct', 'redirect');
  assert.equal(sample.status, 307); assert.equal(sample.correct, false); assert.equal(f.received.length, 1);
});
test('oversized responses cannot acknowledge a write', async t => {
  const f = await server(t, (_, res) => res.end('x'.repeat(1024 * 1024 + 1)));
  const sample = await observeServing({ ...f.settings, workload: 'writes' }, 'direct', 'oversized');
  assert.equal(sample.correct, false); assert.equal(f.received.length, 1);
});
test('ledger reports missing acknowledgments and unknown outcomes separately', () => {
  const samples = [
    { writeId: 'saved', status: 200, correct: true }, { writeId: 'missing', status: 200, correct: true },
    { writeId: 'unknown-saved', status: 0, correct: false }, { writeId: 'unknown-absent', status: 503, correct: false },
  ];
  assert.deepEqual(reconcileWrites(samples, [{ id: 'saved', app: 'baseline' }, { id: 'unknown-saved', app: 'baseline' }]),
    { attempts: 4, committed: 2, acknowledged: 2, acknowledgedMissing: ['missing'], unacknowledgedCommitted: [{ writeId: 'unknown-saved', status: 0 }], unacknowledgedAbsent: [{ writeId: 'unknown-absent', status: 503 }] });
});
for (const rows of [[{ id: 'unattempted', app: 'baseline' }], [{ id: 'a', app: 'peer' }], [{ id: 'a', app: 'baseline' }, { id: 'a', app: 'baseline' }]]) test(`foreign, extra or duplicate ledger rows refuse: ${JSON.stringify(rows)}`, () => {
  assert.throws(() => reconcileWrites([{ writeId: 'a', status: 200, correct: true }], rows), /Unexpected or duplicate/);
});
test('ambiguous or malformed attempt inventories cannot support a result', () => {
  const attempt = { writeId: 'a', status: 200, correct: true };
  for (const samples of [[], [attempt, attempt], [null], [{ ...attempt, writeId: 1 }], [{ ...attempt, status: 900 }], [{ ...attempt, correct: 'yes' }]]) assert.throws(() => reconcileWrites(samples, []), /Missing|Invalid|duplicate/);
});
test('unknown profiles and invalid mutation identities refuse before contacting a server', async () => {
  await assert.rejects(observeServing({ workload: 'constructor' }, 'direct'), /Unknown serving workload/);
  await assert.rejects(observeServing({ workload: 'writes', targets: {} }, 'direct', undefined), /Invalid serving write identity/);
});
