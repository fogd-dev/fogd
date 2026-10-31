import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { previewOwnerBrowserFixture } from './fixtures/preview-owner-browser.mjs';
import { runPreviewOwnerBrowser } from '../src/preview/owner-browser-command.mjs';
import { createPreviewOwnerBrowser } from '../src/preview/owner-browser.mjs';
import { jsonBytes } from '../src/build-cache/paths.mjs';

const proof = f => join(f.directory, 'teardown.complete.json');

test('owner browser status uses a distinct private capability without URLs, cookies or source credentials', async t => {
  const f = await previewOwnerBrowserFixture(t);
  assert.equal((await stat(f.ui.accessFile)).mode & 0o7777, 0o600);
  assert.equal((await stat(dirname(f.ui.accessFile))).mode & 0o7777, 0o700);
  assert.equal(f.access.capability, 'inspect-stop-only'); assert.notEqual(f.access.accessKey, f.input.bundle.ingress.accessKey);
  const page = await fetch(f.ui.origin); assert.equal(page.status, 200); assert.equal(page.headers.get('set-cookie'), null);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok(!(await page.text()).includes(f.access.accessKey));
  for (const headers of [{ authorization: '' }, { authorization: 'Bearer ' + f.input.bundle.ingress.accessKey }, { origin: 'https://other.test' }, { origin: 'null' }, { origin: '' }]) {
    assert.equal((await f.request('status', {}, { headers })).status, 403);
  }
  assert.deepEqual(f.calls, []);
  const response = await f.request('status'), value = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(value.state, 'running'); assert.equal(value.preview, f.args.envelope.grant.preview); assert.equal(value.digest, f.args.envelope.grant.source.digest);
  for (const secret of [f.access.accessKey, f.args.secretValues.storagePassword, f.input.bundle.ingress.accessKey, f.source.env.FOGD_ADMIN_PASSWORD]) assert.ok(!JSON.stringify(value).includes(secret));
  assert.deepEqual(f.source.calls, []); assert.ok(f.calls.every(args => !['stop', 'start', 'rm', 'kill'].includes(args[0])));
});

test('browser decline completes ordered stop, retains data and memory, and repeated stop preserves first proof', async t => {
  const f = await previewOwnerBrowserFixture(t), original = structuredClone(f.source.state);
  const result = await (await f.request('stop', { reason: 'declined' })).json();
  assert.equal(result.state, 'stopped'); assert.equal(result.shutdownOrdered, true); assert.equal(result.stopReason, 'declined');
  assert.equal(result.memoryBudgetHeld, true); assert.equal(result.resourcesRetained, true);
  const complete = await readFile(proof(f)), stops = f.calls.filter(args => args[0] === 'stop').length; assert.equal(stops, 4);
  const repeated = await (await f.request('stop', { reason: 'revoked' })).json(); assert.equal(repeated.stopReason, 'declined');
  assert.deepEqual(await readFile(proof(f)), complete); assert.equal(f.calls.filter(args => args[0] === 'stop').length, stops);
  assert.equal(f.f.observed.containers.length, 10); assert.ok(f.f.observed.containers.every(row => !row.State.Running));
  assert.ok(!(await readdir(f.directory)).includes('memory.released.json')); assert.deepEqual(f.source.state, original); assert.deepEqual(f.source.calls, []);
});

test('browser API accepts no target selection, retirement, activation or oversized owner action', async t => {
  const f = await previewOwnerBrowserFixture(t);
  for (const action of ['retire', 'launch', 'approve', 'status/other']) assert.equal((await f.request(action)).status, 404);
  for (const body of [{}, { reason: 'wrong' }, { reason: 'declined', allocationId: 'other' }]) assert.equal((await f.request('stop', body)).status, 400);
  assert.equal((await f.request('status', { padding: 'x'.repeat(3000) })).status, 413);
  assert.deepEqual(f.calls, []);
});

test('a valid replacement owner control cannot silently change the browser target', async t => {
  const f = await previewOwnerBrowserFixture(t), path = join(f.ownerDirectory, 'owner.json'), value = JSON.parse(await readFile(path));
  value.dockerContext = 'different-context'; await writeFile(path, jsonBytes(value));
  assert.equal((await f.request('stop', { reason: 'revoked' })).status, 503); assert.deepEqual(f.calls, []);
  assert.ok(!(await readdir(f.directory)).includes('stop.requested.json'));
});

test('an authorized stop survives browser disconnect and UI close without queueing another stop', async t => {
  let entered, release, waiting = true; const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await previewOwnerBrowserFixture(t, { transport: async (x, args, ...extra) => {
    if (args[0] === 'stop' && waiting) { waiting = false; entered(); await gate; }
    return x.args.run(args, ...extra);
  } });
  const cancellation = new AbortController(), pending = f.request('stop', { reason: 'revoked' }, { signal: cancellation.signal });
  void pending.catch(() => {}); await reached;
  assert.equal((await f.request('stop', { reason: 'declined' })).status, 409);
  cancellation.abort(); await assert.rejects(pending, { name: 'AbortError' });
  let closed = false; const closing = f.ui.close().then(() => { closed = true; });
  await delay(20); assert.equal(closed, false); release(); await closing;
  assert.equal(JSON.parse(await readFile(proof(f))).ordered, true); assert.equal(JSON.parse(await readFile(join(f.directory, 'stop.requested.json'))).reason, 'revoked'); assert.equal(f.calls.filter(args => args[0] === 'stop').length, 4);
  assert.ok(f.f.observed.containers.every(row => !row.State.Running));
});

test('unknown Docker stop effects stay fenced, expose no private cause and receive no automatic retry', async t => {
  const f = await previewOwnerBrowserFixture(t, { transport: async (x, args, ...extra) => {
    const result = await x.args.run(args, ...extra); if (args[0] === 'stop') throw Error('PRIVATE_DOCKER_FAILURE'); return result;
  } });
  const response = await f.request('stop', { reason: 'declined' }); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('PRIVATE_'));
  const status = await (await f.request('status')).json(); assert.equal(status.state, 'pending'); assert.equal(status.runtimeObserved, false);
  assert.equal(f.calls.filter(args => args[0] === 'stop').length, 1); assert.equal(JSON.parse(await readFile(join(f.host, 'launch.pending.json'))).phase, 'writing');
  assert.ok(!(await readdir(f.directory)).includes('teardown.complete.json'));
});

test('closing the owner browser on SIGTERM requests no preview stop and removes process listeners', async t => {
  const f = await previewOwnerBrowserFixture(t), before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], events = [];
  await runPreviewOwnerBrowser({ directory: f.ownerDirectory, allocationId: f.args.allocationId, run: f.args.run }, value => {
    events.push(value); if (value.event === 'owner-browser-ready') process.emit('SIGTERM');
  });
  t.after(() => rm(dirname(events[0].accessFile), { recursive: true }));
  assert.deepEqual(events.map(value => value.event), ['owner-browser-ready', 'owner-browser-closed']);
  assert.equal(events[1].previewStopRequested, false); assert.ok(!f.calls.some(args => args[0] === 'stop'));
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
});

test('real manage CLI publishes private loopback access and exits without stopping the preview', { timeout: 30000 }, async t => {
  const f = await previewOwnerBrowserFixture(t), tools = join(f.input.root, 'browser-tools'), calls = join(f.input.root, 'browser-cli-calls.jsonl');
  const { mkdir } = await import('node:fs/promises'); await mkdir(tools);
  const data = join(f.input.root, 'browser-cli-state.json'); await writeFile(data, JSON.stringify({ observed: f.f.observed, image: f.f.image }), { mode: 0o600 });
  await writeFile(join(tools, 'docker'), `#!${process.execPath}
import{readFile,appendFile}from'node:fs/promises';const input=process.argv.slice(2),args=input.slice(2);if(input[0]!=='--context'||input[1]!=='owner-browser-fixture')process.exit(2);await appendFile(${JSON.stringify(calls)},JSON.stringify({args,ambient:Object.keys(process.env).filter(k=>k.startsWith('DOCKER_')||k.startsWith('FOGD_'))})+'\\n');const{observed:v,image}=JSON.parse(await readFile(${JSON.stringify(data)}));if(args[0]==='info')console.log(JSON.stringify(v.host));else if(args[0]==='image')console.log(JSON.stringify([image]));else{const items=v[{container:'containers',network:'networks',volume:'volumes'}[args[0]]];if(!items)process.exit(3);if(args[1]==='ls')console.log(items.map(i=>args[0]==='volume'?i.Name:i.Id).join('\\n'));else if(args[1]==='inspect')console.log(JSON.stringify(items));else process.exit(4)}
`, { mode: 0o700 });
  const bin = new URL('../bin/fogd.js', import.meta.url).pathname;
  const child = spawn(process.execPath, [bin, 'preview', 'manage', f.args.allocationId, '--control', f.ownerDirectory], {
    env: { ...process.env, ...f.source.env, PATH: tools, DOCKER_HOST: 'tcp://wrong-host', DOCKER_CONTEXT: 'wrong-context' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = []; let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; });
  const ready = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => { if (!events.length) reject(Error(stderr || 'manage exited before readiness')); });
    createInterface({ input: child.stdout }).on('line', line => { const event = JSON.parse(line); events.push(event); if (event.event === 'owner-browser-ready') resolve(event); });
  });
  t.after(() => rm(dirname(ready.accessFile), { recursive: true }));
  assert.equal(new URL(ready.origin).hostname, '127.0.0.1'); assert.equal(ready.capability, 'inspect-stop-only');
  const access = JSON.parse(await readFile(ready.accessFile)); assert.notEqual(access.accessKey, f.access.accessKey);
  const response = await fetch(ready.origin + '/status', { method: 'POST', headers: { origin: ready.origin, authorization: 'Bearer ' + access.accessKey, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await response.json()).state, 'running'); assert.equal(response.status, 200);
  child.kill('SIGTERM'); assert.deepEqual(await closed, { code: 0, signal: null }, stderr); assert.equal(stderr, '');
  assert.deepEqual(events.map(event => event.event), ['owner-browser-ready', 'owner-browser-closed']);
  assert.ok(!JSON.stringify(events).includes(access.accessKey)); assert.equal(events[1].previewStopRequested, false);
  const observed = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(observed.every(row => row.ambient.length === 0 && !['stop', 'start', 'rm', 'kill'].includes(row.args[0])));
});


test('a temporary directory inside retained host state refuses before creating any access directory', async t => {
  const f = await previewOwnerBrowserFixture(t), before = await readdir(f.host), previous = process.env.TMPDIR;
  try {
    process.env.TMPDIR = f.host;
    await assert.rejects(createPreviewOwnerBrowser({ directory: f.ownerDirectory, allocationId: f.args.allocationId, run: f.args.run }), /Owner access location refused/);
  } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  assert.deepEqual(await readdir(f.host), before); assert.ok(!f.calls.some(args => args[0] === 'stop'));
});
