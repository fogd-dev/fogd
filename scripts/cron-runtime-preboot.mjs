// App-free qualification only; no scheduled application or restored hold gate.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { verifyCronRuntimeImage, verifyCronStorageImage } from '../packages/cli/src/runtime/cron-image.mjs';
import { verifyIdentityProof } from '../packages/platform/src/runtime-identity-proof.mjs';
import { prebootFixture, prebootMutants, prebootInputs } from './cron-probe/preboot/fixture.mjs';

assert.ok(process.argv[2], 'Supply a new private output directory');
const probe = await prebootFixture(process.argv[2]);
let failure;
try {
  await verifyCronStorageImage(probe.profile.storageImage);
  await verifyCronRuntimeImage(probe.profile);
  const refused = [];
  for (const mutant of await prebootMutants(probe)) {
    await assert.rejects(verifyCronRuntimeImage({ ...probe.profile, image: mutant.id }), /preboot verification failed/);
    refused.push(mutant);
  }
  await probe.compose(['up', '-d', '--no-build', '--pull', 'never']);
  const observed = await ready(probe);
  for (const value of observed.identities) {
    const identity = verifyIdentityProof(value.proof, value.challenge);
    assert.equal(identity.binarySha256, probe.profile.binarySha256);
  }
  const filter = `label=com.docker.compose.project=${probe.project}`;
  const ids = (await execute('docker', ['ps', '-aq', '--filter', filter])).trim().split(/\s+/);
  const containers = JSON.parse(await execute('docker', ['inspect', ...ids]));
  const runtime = containers.map(container => checkedContainer(probe, container));
  const writes = [];
  for (const service of Object.keys(probe.config.services).filter(name => !['minio', 'bucket-init'].includes(name))) {
    const code = `const fs=require('node:fs'),cp=require('node:child_process'); let result;try{fs.writeFileSync('/usr/local/bin/fogd-preboot-write','must-refuse')}catch(error){result=error.code}if(result!=='EROFS')throw Error('Program directory writable');fs.writeFileSync('/tmp/fogd-preboot-noexec','#!/bin/sh\\nexit 0\\n',{mode:0o700});const execution=cp.spawnSync('/tmp/fogd-preboot-noexec');if(execution.error?.code!=='EACCES')throw Error('Temporary executable allowed');console.log(JSON.stringify({programWrite:result,tmpWrite:true,tmpExec:execution.error.code}));`;
    const result = JSON.parse(await probe.compose(['exec', '-T', service, '/usr/local/bin/node', '-e', code]));
    writes.push({ service, ...result });
  }
  assert.deepEqual(await prebootInputs(), probe.inputs, 'Executed qualification sources changed');
  await probe.save('preboot', { project: probe.project, profile: probe.profile, refused, observed, runtime, writes,
    scope: 'Actual release-image inspection and app-free read-only startup only. No scheduled app, backup, restored hold, runtime registry or ordinary cron admission qualification.' });
} catch (error) { failure = error; await probe.save('failure', { message: error.message }); throw error; }
finally {
  const filter = `label=com.docker.compose.project=${probe.project}`;
  const volumes = async () => (await execute('docker', ['volume', 'ls', '-q', '--filter', filter])).trim().split('\n').filter(Boolean).sort();
  const before = await volumes();
  try { await probe.save('logs', { logs: await probe.compose(['logs', '--no-color']) }); }
  finally { await probe.compose(['down']); }
  const retained = await volumes(); assert.deepEqual(retained, before);
  if (!failure) assert.equal(retained.length, Object.keys(probe.config.volumes).length);
  assert.equal((await execute('docker', ['ps', '-aq', '--filter', filter])).trim(), '');
  assert.equal((await execute('docker', ['network', 'ls', '-q', '--filter', filter])).trim(), '');
  await probe.save('cleanup', { stopped: true, retainedVolumes: retained });
}
console.log('PASS: checked program paths and inherited image settings, rejected real image mutants, and booted app-free services with read-only programs and non-executable temporary files; owned volumes retained');

async function ready(probe) {
  const hosts = probe.profile.fleets.flatMap(fleet => fleet.nodes.map(node => node.host));
  const code = `import {randomBytes} from 'node:crypto';const hosts=${JSON.stringify(hosts)};const headers={Authorization:'Basic '+Buffer.from(process.env.FOGD_ADMIN_USER+':'+process.env.FOGD_ADMIN_PASSWORD).toString('base64')};const admin=await fetch('http://127.0.0.1:8082/v1/admin',{headers,signal:AbortSignal.timeout(1500)});if(admin.status!==200)throw Error('Controller not ready');const state=await admin.json();if(Object.keys(state.apps).length||Object.keys(state.deployments).length)throw Error('Expected app-free controller');const health=await fetch('http://workerd:8080/.well-known/fogd/health',{signal:AbortSignal.timeout(1500)});if(!health.ok)throw Error('Gateway not ready');const identities=await Promise.all(hosts.map(async host=>{const challenge=randomBytes(32).toString('hex');const result=await fetch('http://'+host+':8082/runtime/identity?challenge='+challenge,{signal:AbortSignal.timeout(1500)});if(!result.ok)throw Error('Identity not ready');return {host,challenge,proof:await result.json()}}));console.log(JSON.stringify({adminStatus:admin.status,applications:0,deployments:0,gatewayStatus:health.status,identities}));`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { return JSON.parse(await probe.compose(['exec', '-T', 'controller', '/usr/local/bin/node', '--input-type=module', '-e', code])); }
    catch { await setTimeout(1000); }
  }
  throw new Error('App-free read-only installation did not become ready');
}
function checkedContainer(probe, container) {
  const service = container.Config.Labels['com.docker.compose.service'], expected = probe.config.services[service];
  assert.ok(expected); assert.equal(container.Image, expected.image);
  {
    assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(container.HostConfig.CapDrop, ['ALL']);
    assert.equal(container.HostConfig.Tmpfs['/tmp'], 'rw,noexec,nosuid,nodev');
    const actual = container.Mounts.filter(mount => mount.Type === 'volume').map(mount => [mount.Name, mount.Destination, mount.RW]).sort();
    const configured = (expected.volumes || []).map(mount => [probe.config.volumes[mount.source].name, mount.target, !mount.read_only]).sort();
    assert.deepEqual(actual, configured);
    assert.ok(container.Mounts.every(mount => mount.Type === 'volume' || (mount.Type === 'tmpfs' && mount.Destination === '/tmp')));
  }
  if (service === 'bucket-init') assert.equal(container.State.ExitCode, 0);
  else assert.equal(container.State.Running, true);
  return { service, image: container.Image, readOnlyRootfs: container.HostConfig.ReadonlyRootfs, state: container.State.Status,
    mounts: container.Mounts.map(({ Type, Name, Destination, RW }) => ({ type: Type, name: Name || null, target: Destination, writable: RW })) };
}
