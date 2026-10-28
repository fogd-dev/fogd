import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { docker, json, projectName } from '../../../packages/cli/src/recovery/docker.mjs';
import { runtimeFamily } from '../../../packages/cli/src/runtime/catalog.mjs';
import { DebuggerTransport } from './debugger-transport.mjs';
import { SourceDebugger } from './source-debugger.mjs';

export async function controllerProcess(container, project, family, run = docker) {
  projectName(project);
  const entry = runtimeFamily(family, 'enrolled'), image = entry.image;
  const command = [entry.routing === 'durable' ? 'packages/platform/src/main-durable.mjs' : 'packages/platform/src/main.mjs'];
  const [actual] = JSON.parse(await run(['inspect', container]));
  if (actual.Id !== container || actual.Image !== image || !actual.State.Running || !actual.HostConfig.ReadonlyRootfs ||
    actual.Config.Labels?.['com.docker.compose.project'] !== project || actual.Config.Labels?.['com.docker.compose.service'] !== 'controller' ||
    !isDeepStrictEqual(actual.Config.Entrypoint, ['/usr/local/bin/node']) || !isDeepStrictEqual(actual.Config.Cmd, command)) throw new Error('Controller identity or launch no longer matches');
  const code = `import{readFile}from'node:fs/promises';const args=(await readFile('/proc/1/cmdline','utf8')).split(String.fromCharCode(0)).filter(Boolean);if(JSON.stringify(args)!==JSON.stringify(${JSON.stringify(['/usr/local/bin/node', ...command])}))throw Error('Unexpected controller launch');const stat=await readFile('/proc/1/stat','utf8');const children=await readFile('/proc/1/task/1/children','utf8');if(children.trim())throw Error('Controller has an active child');console.log(JSON.stringify({processStart:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}));`;
  const process = JSON.parse(await run(['exec', container, '/usr/local/bin/node', '--input-type=module', '-e', code]));
  return { container, project, family, image, startedAt: actual.State.StartedAt, processStart: process.processStart };
}

export async function openControllerDebugger(container, project, family) {
  const entry = runtimeFamily(family, 'enrolled'), identity = await controllerProcess(container, project, family);
  await verifyRunningPrograms(container, entry.sourceFiles);
  await docker(['kill', '--signal', 'USR1', container]);
  const agent = await readFile(new URL('./inspector-agent.mjs', import.meta.url), 'utf8'), transport = new DebuggerTransport(container, agent);
  try {
    const ready = await transport.ready();
    if (ready.processStart !== identity.processStart) throw new Error('Controller restarted before debugger attachment');
    const debuggerSession = new SourceDebugger(transport, entry.sourceFiles);
    await debuggerSession.enable();
    return { identity, debuggerSession };
  } catch (error) { await transport.close(); throw error; }
}

export async function killController(identity) {
  const current = await controllerProcess(identity.container, identity.project, identity.family);
  if (current.image !== identity.image || current.processStart !== identity.processStart || current.startedAt !== identity.startedAt) throw new Error('Controller process changed before interruption');
  await docker(['kill', '--signal', 'KILL', identity.container]);
  const code = (await docker(['wait', identity.container])).trim();
  const [actual] = await json(['inspect', identity.container]);
  if (code !== '137' || actual.State.OOMKilled || actual.State.Running || actual.State.Restarting) throw new Error('Controller SIGKILL outcome was not confirmed');
  return { exitCode: 137, oomKilled: false, stopped: true, restartCount: actual.RestartCount };
}


async function verifyRunningPrograms(container, expected) {
  const code = `import{readFile,lstat}from'node:fs/promises';import{createHash}from'node:crypto';const files={};for(const name of ${JSON.stringify(Object.keys(expected))}){const path='/app/'+name;if(!(await lstat(path)).isFile())throw Error('Program must be regular');files[name]=createHash('sha256').update(await readFile(path)).digest('hex');}console.log(JSON.stringify(files));`;
  const actual = JSON.parse(await docker(['exec', container, '/usr/local/bin/node', '--input-type=module', '-e', code]));
  if (!isDeepStrictEqual(actual, expected)) throw new Error('Running controller programs differ from the catalog');
}
