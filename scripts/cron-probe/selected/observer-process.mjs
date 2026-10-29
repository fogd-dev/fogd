import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { observerOptions } from './observer-container.mjs';

const prefix = '/app/scripts/cron-probe/selected/';

// Keep a pinned reader container available for observations within native deadlines.
export async function observerProcess(host, slotId, channel, programs) {
  assert.ok(['native', 'storage'].includes(channel));
  assert.ok(programs.length > 0 && new Set(programs).size === programs.length);
  const fleet = host.policy.fleets.find(value => value.id === slotId); assert.ok(fleet);
  const network = channel === 'storage' ? 'control' : `fleet-${host.policy.fleets.indexOf(fleet) + 1}`;
  const name = `fogd-diagnostic-reader-${randomBytes(8).toString('hex')}`, sources = {}, files = {};
  for (const name of programs) {
    assert.match(name, /^[a-z][a-z-]*\.mjs$/);
    const bytes = await readFile(fileURLToPath(new URL(name, import.meta.url)));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    sources[`scripts/cron-probe/selected/${name}`] = sha256;
    files[name] = { data: bytes.toString('base64'), sha256 };
  }
  const programVolume = `${name}-programs`;
  let id;
  try {
    await host.run('docker', ['volume', 'create', '--label', `fogd.qualifier.project=${host.project}`, programVolume]);
    await stagePrograms(host, programVolume, files);
    id = (await host.run('docker', ['run', '-d', ...(host.retainResources ? [] : ['--rm']), '--name', name, ...observerOptions(host, host.config.networks[network].name), '--mount', `type=volume,src=${programVolume},dst=${prefix},readonly`,
      '--entrypoint', '/usr/local/bin/node', host.entry.image, '-e', 'setInterval(()=>{},60000)'])).trim();
    assert.match(id, /^[a-f0-9]{64}$/);
    const [container] = JSON.parse(await host.run('docker', ['inspect', id]));
    assert.equal(container.Image, host.entry.image); assert.equal(container.State.Running, true); assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert.equal(container.Config.Labels['fogd.qualifier.project'], host.project);
    assert.equal(container.RestartCount, 0); assert.equal(container.State.OOMKilled, false);
    assert.equal(Object.keys(container.NetworkSettings.Networks).length, 1); assert.ok(container.NetworkSettings.Networks[host.config.networks[network].name]);
    assert.ok(container.Mounts.filter(mount => mount.Type !== 'tmpfs').every(mount => mount.RW === false));
    assert.deepEqual(container.HostConfig.CapDrop, ['ALL']); assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges'));
    return {
      inspect: { id, name, image: container.Image, network: host.config.networks[network].name, channel, sources, programVolume },
      async read(input) {
        return JSON.parse(await host.run('docker', ['exec', '-i', id, '/usr/local/bin/node', `${prefix}${programs[0]}`], { inputText: JSON.stringify(input), timeout: 30000 }));
      },
      async close() {
        await host.run('docker', host.retainResources ? ['stop', id] : ['rm', '-f', id]);
        if (!host.retainResources) await host.run('docker', ['volume', 'rm', programVolume]);
      },
    };
  } catch (error) {
    if (id) { try { await host.run('docker', host.retainResources ? ['stop', id] : ['rm', '-f', id]); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Observer setup and cleanup failed'); } }
    if (!host.retainResources) await host.run('docker', ['volume', 'rm', programVolume]);
    throw error;
  }
}

async function stagePrograms(host, volume, files) {
  const code = `import assert from'node:assert/strict';import{writeFile,readFile}from'node:fs/promises';import{createHash}from'node:crypto';
let input='';for await(const part of process.stdin){input+=part;if(input.length>1048576)throw Error('Reader sources exceed limit');}
for(const[name,file]of Object.entries(JSON.parse(input))){assert.match(name,/^[a-z][a-z-]*\\.mjs$/);const bytes=Buffer.from(file.data,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);const path='/programs/'+name;await writeFile(path,bytes,{flag:'wx',mode:0o444});assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),file.sha256);}`;
  await host.run('docker', ['run', '--rm', '-i', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,src=${volume},dst=/programs`, '--entrypoint', '/usr/local/bin/node', host.entry.image, '--input-type=module', '-e', code], { inputText: JSON.stringify(files) });
}
