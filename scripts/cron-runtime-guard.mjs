// Native caller-policy qualification on a fresh owned installation.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { fixture, finishFixture } from './cron-probe/identity/fixture.mjs';
import { observe, identity } from './cron-probe/identity/checks.mjs';

const binary = process.argv[5]; assert.match(binary || '', /^[a-f0-9]{64}$/);
assert.ok(process.argv[4], 'Supply the guarded observer image');
const probe = await fixture(process.argv[2], process.argv[3], { observerImage: process.argv[4] });
let failure;
try {
  await probe.compose(['up', '-d']);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await observe(probe, 'a')).status === 200 && (await observe(probe, 'b')).status === 200) { ready = true; break; }
    await setTimeout(500);
  }
  assert.ok(ready);
  await Promise.all(['a', 'b'].map(node => identity(probe, node, binary)));
  await setTimeout(3000);
  const runtime = (await probe.compose(['ps', '--all', '--format', 'json'])).trim().split('\n').map(line => JSON.parse(line));
  for (const service of ['a', 'b', 'older', 'disabled', 'observer', 'minio']) assert.equal(runtime.find(row => row.Service === service)?.State, 'running');
  const processes = {};
  for (const host of ['a', 'b', 'older']) {
    processes[host] = (await probe.compose(['exec', '-T', host, 'sha256sum', '/proc/1/exe'])).trim().split(/\s/)[0];
    assert.match(processes[host], /^[a-f0-9]{64}$/);
  }
  assert.equal(processes.a, binary); assert.equal(processes.b, binary); assert.notEqual(processes.older, binary);
  await probe.compose(['cp', 'scripts/cron-probe/identity/guard-controller.mjs', 'observer:/tmp/guard-controller.mjs']);
  const result = JSON.parse((await probe.compose(['exec', '-T', 'observer', 'node', '/tmp/guard-controller.mjs', binary])).trim());
  await probe.save('guard', { project: probe.project, images: probe.images, binary, processes, runtime: runtime.map(({ Service, State, ExitCode, Image }) => ({ Service, State, ExitCode, Image })), ...result });
} catch (error) { failure = error; await probe.save('failure', { message: error.message }); throw error; }
finally {
  try {
    await finishFixture(probe, Boolean(failure));
  } catch (error) { if (failure) throw new AggregateError([failure, error], 'Guard probe and cleanup failed'); throw error; }
}
console.log('PASS: native caller policy refuses before dispatch and verifies every app-free bootstrap/control command; owned containers removed and volumes retained');
