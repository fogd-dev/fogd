import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectContainers, stopped } from '../../../packages/cli/src/recovery/docker.mjs';

export async function recoveryFence(target, installations) {
  const home = target.env.FOGD_HOME, edges = [];
  for (const host of installations) {
    assert.equal(host.env.FOGD_HOME, home);
    const volumes = Object.values(host.config.volumes).map(volume => volume.name);
    if (host.project !== target.project) await stopped(host.project, volumes);
    if (host.sourceProject) {
      const record = JSON.parse(await readFile(join(home, '.fogd/installations', host.project, 'recovery-source.json')));
      assert.equal(record.sourceProject, host.sourceProject); edges.push(record);
    }
  }
  const module = fileURLToPath(new URL('../../../packages/cli/src/runtime/recovery-source.mjs', import.meta.url));
  const local = new URL('../../../packages/cli/src/local.mjs', import.meta.url).href;
  const code = `import{stackRoot}from ${JSON.stringify(local)};import{assertRecoverySourceStopped}from ${JSON.stringify(module)};if(stackRoot!==process.env.FOGD_HOME)throw Error('Recovery fence home mismatch');await assertRecoverySourceStopped(${JSON.stringify(target.project)});console.log(JSON.stringify({home:stackRoot,project:${JSON.stringify(target.project)}}));`;
  const checked = JSON.parse(await target.run(process.execPath, ['--input-type=module', '-e', code]));
  assert.equal(checked.home, home); assert.equal(checked.project, target.project);
  return { home, edges, stoppedProjects: installations.filter(host => host.project !== target.project).map(host => host.project) };
}

export async function neverStartedIngress(host) {
  const containers = await projectContainers(host.project);
  for (const name of ['controller', 'workerd']) {
    const matches = containers.filter(container => container.Config.Labels['com.docker.compose.service'] === name);
    assert.equal(matches.length, 1);
    const [container] = matches;
    assert.equal(String(container.Config.Labels['com.docker.compose.oneoff']).toLowerCase(), 'false');
    assert.equal(container.State.Running, false); assert.equal(container.State.Restarting, false); assert.equal(container.RestartCount, 0);
    assert.ok(container.State.StartedAt.startsWith('0001-'));
  }
  return containers.filter(container => ['controller', 'workerd'].includes(container.Config.Labels['com.docker.compose.service']))
    .map(container => ({ id: container.Id, service: container.Config.Labels['com.docker.compose.service'], startedAt: container.State.StartedAt, restartCount: container.RestartCount }));
}

export async function nativeProcesses(host) {
  host.access?.({ kind: 'replica-process-inventory' });
  const containers = await projectContainers(host.project), result = [];
  const code = "import{readdir,readFile}from'node:fs/promises';const found=[];for(const pid of(await readdir('/proc')).filter(name=>/^\\d+$/.test(name))){try{if((await readFile('/proc/'+pid+'/comm','utf8')).trim()!=='celld')continue;const stat=await readFile('/proc/'+pid+'/stat','utf8');found.push({pid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]});}catch(error){if(error.code!=='ENOENT')throw error;}}if(found.length!==1)throw Error('Expected one native process');console.log(JSON.stringify(found[0]));";
  for (const fleet of host.policy.fleets) for (const node of fleet.nodes) {
    const container = containers.find(value => value.Config.Labels['com.docker.compose.service'] === node.host);
    assert.ok(container && container.State.Running && !container.State.OOMKilled && container.RestartCount === 0 && container.Image === host.entry.image);
    const network = host.config.networks[`fleet-${host.policy.fleets.indexOf(fleet) + 1}`].name;
    const connection = container.NetworkSettings.Networks[network]; assert.ok(connection?.NetworkID);
    const process = JSON.parse(await host.run('docker', ['exec', container.Id, '/usr/local/bin/node', '--input-type=module', '-e', code]));
    result.push({ host: node.host, container: container.Id, project: host.project, network: connection.NetworkID, image: container.Image, ...process });
  }
  return result;
}
