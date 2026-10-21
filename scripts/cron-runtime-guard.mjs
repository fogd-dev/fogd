// Native caller-policy qualification on a fresh owned installation.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { fixture, finishFixture } from './cron-probe/identity/fixture.mjs';
import { configureBindingFixture } from './cron-probe/binding/fixture.mjs';
import { observe, identity, bucketSnapshot } from './cron-probe/identity/checks.mjs';

const binary = process.argv[5]; assert.match(binary || '', /^[a-f0-9]{64}$/);
assert.ok(process.argv[4], 'Supply the guarded observer image');
const probe = await fixture(process.argv[2], process.argv[3], { observerImage: process.argv[4], configure: configureBindingFixture });
let failure;
try {
  await probe.compose(['up', '-d']);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await observe(probe, 'a')).status === 200 && (await observe(probe, 'b')).status === 200 && (await observe(probe, 'other-target')).status === 200) { ready = true; break; }
    await setTimeout(500);
  }
  assert.ok(ready);
  const identities = await Promise.all(['a', 'b'].map(node => identity(probe, node, binary)));
  const otherIdentity = await identity(probe, 'other-target', binary, { endpoint: 'http://minio-other:9000' });
  assert.equal(otherIdentity.namespaceSha256, identities[0].namespaceSha256);
  assert.notEqual(otherIdentity.storageSha256, identities[0].storageSha256);
  await setTimeout(3000);
  const runtime = (await probe.compose(['ps', '--all', '--format', 'json'])).trim().split('\n').map(line => JSON.parse(line));
  for (const service of ['a', 'b', 'older', 'disabled', 'other-target', 'observer', 'minio', 'minio-other']) assert.equal(runtime.find(row => row.Service === service)?.State, 'running');
  const processes = {};
  for (const host of ['a', 'b', 'other-target', 'older']) {
    processes[host] = (await probe.compose(['exec', '-T', host, 'sha256sum', '/proc/1/exe'])).trim().split(/\s/)[0];
    assert.match(processes[host], /^[a-f0-9]{64}$/);
  }
  assert.equal(processes.a, binary); assert.equal(processes.b, binary); assert.equal(processes['other-target'], binary); assert.notEqual(processes.older, binary);
  const otherBefore = await bucketSnapshot(probe, 'http://minio-other:9000');
  await probe.compose(['cp', 'scripts/cron-probe/identity/guard-controller.mjs', 'observer:/tmp/guard-controller.mjs']);
  const result = JSON.parse((await probe.compose(['exec', '-T', 'observer', 'node', '/tmp/guard-controller.mjs', binary])).trim());
  const otherAfter = await bucketSnapshot(probe, 'http://minio-other:9000');
  assert.deepEqual(otherAfter, otherBefore);
  await probe.save('guard', { project: probe.project, images: probe.images, binary, processes, identities, otherIdentity, otherBefore, otherAfter, runtime: runtime.map(({ Service, State, ExitCode, Image }) => ({ Service, State, ExitCode, Image })), ...result });
} catch (error) { failure = error; await probe.save('failure', { message: error.message }); throw error; }
finally {
  try {
    await finishFixture(probe, Boolean(failure));
  } catch (error) { if (failure) throw new AggregateError([failure, error], 'Guard probe and cleanup failed'); throw error; }
}
console.log('PASS: native caller policy refuses before dispatch and verifies every app-free bootstrap/control command; owned containers removed and volumes retained');
