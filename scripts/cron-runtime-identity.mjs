// Qualify metadata before first deployment. Never issue a cron or deploy command.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { fixture } from './cron-probe/identity/fixture.mjs';
import { observe, identity, bucketSnapshot, protocol } from './cron-probe/identity/checks.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';

const probe = await fixture(process.argv[2], process.argv[3]);
let failure;
try {
  await probe.compose(['up', '-d']);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await observe(probe, 'a')).status === 200 && (await observe(probe, 'b')).status === 200) { ready = true; break; }
    await setTimeout(500);
  }
  assert.ok(ready, 'Both native identity listeners must become available before first deployment');
  const binaries = {};
  for (const host of ['a', 'b']) {
    const digests = (await probe.compose(['exec', '-T', host, 'sha256sum', '/proc/1/exe', '/out/celld'])).trim().split('\n').map(line => line.split(/\s/)[0]);
    assert.equal(digests[0], digests[1], 'Running executable must match the checked image artifact');
    binaries[host] = digests[0];
    assert.match(binaries[host], /^[a-f0-9]{64}$/);
  }
  assert.equal(binaries.a, binaries.b);
  // Allow native startup's format probe to finish before measuring GET effects.
  await setTimeout(3000);
  const before = await bucketSnapshot(probe);
  assert.ok(before.every(row => !row.key.includes('/deploy/') && !row.key.includes('.cron:')));
  const identities = await Promise.all(['a', 'b'].map(host => identity(probe, host, binaries[host])));
  const negative = {};
  for (const host of ['disabled', 'older']) {
    negative[host] = await observe(probe, host);
    assert.deepEqual(negative[host], { unavailable: true, code: 'ECONNREFUSED' });
  }
  const http = await protocol(probe);
  for (let read = 0; read < 20; read++) await identity(probe, 'a', binaries.a);
  const after = await bucketSnapshot(probe);
  assert.deepEqual(after, before, 'Identity GETs must leave every bucket object unchanged');
  const runtime = (await probe.compose(['ps', '--all', '--format', 'json'])).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(['a', 'b', 'disabled', 'older', 'observer', 'minio'].every(service => runtime.some(row => row.Service === service && row.State === 'running')));
  const startupRefusals = {};
  for (const service of ['invalid', 'devstore']) {
    const row = runtime.find(row => row.Service === service);
    assert.equal(row?.State, 'exited');
    assert.notEqual(row.ExitCode, 0);
    const logs = await probe.compose(['logs', '--no-color', service]);
    assert.match(logs, /CELLD_RUNTIME_IDENTITY_LISTEN/);
    if (service === 'devstore') assert.match(logs, /local development store/);
    startupRefusals[service] = { state: row.State, exitCode: row.ExitCode };
  }
  await probe.save('identity', { project: probe.project, images: probe.images,
    binaries, identities, negative, http, before, after, runtime, startupRefusals,
    scope: 'Early native metadata only; no deployments or cron commands. Does not qualify release binding, restored startup, mixed runtimes, or cron admission.' });
} catch (error) {
  failure = error;
  await probe.save('failure', { message: error.message });
  throw error;
} finally {
  try {
    const retainedBefore = (await execute('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${probe.project}`])).trim().split('\n').filter(Boolean).sort();
    try { await probe.save('logs', { logs: await probe.compose(['logs', '--no-color']) }); }
    finally { await probe.compose(['down']); }
    const containers = await execute('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${probe.project}`]);
    assert.equal(containers.trim(), '');
    const volumes = (await execute('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${probe.project}`])).trim().split('\n').filter(Boolean).sort();
    assert.deepEqual(volumes, retainedBefore, 'Cleanup must retain every volume, including after partial setup');
    if (!failure) assert.equal(volumes.length, 5);
    await probe.save('cleanup', { stopped: true, retainedVolumes: volumes });
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], 'Identity probe and cleanup failed');
    throw error;
  }
}
console.log('PASS: early identity matches the running binaries, node IDs and namespace; GETs preserve bucket state; owned containers removed and volumes retained');
