import { isDeepStrictEqual } from 'node:util';
import { readRuntimeConfiguration } from '../runtime/installation-state.mjs';
import { readInstalledPolicy } from '../runtime/installed-policy.mjs';
import { selectedRuntimeConfig } from '../runtime/selection-plan.mjs';
import { docker, json, projectContainers } from '../recovery/docker.mjs';
import { volumeHelper } from '../recovery/volumes.mjs';

export async function observationInstallation(project) {
  const config = await readRuntimeConfiguration(project);
  await requireVolumes(config);
  const installed = await readInstalledPolicy(config);
  if (!installed || installed.entry.admission !== 'qualified') throw new Error('Local observation requires an enrolled qualified Docker installation');
  if (!isDeepStrictEqual(selectedRuntimeConfig(config, installed.entry, installed.policy), config)) throw new Error('Installed observation configuration differs from its independent runtime policy');
  return { project, config, ...installed };
}
export async function requireVolumes(config) {
  const names = new Set((await docker(['volume', 'ls', '--format', '{{.Name}}'])).trim().split('\n'));
  for (const role of ['controller', 'runtime-policy']) {
    if (!config.volumes[role]?.name || !names.has(config.volumes[role].name)) throw new Error('Observation data or policy volume is absent; no volume was created');
  }
}
export async function readObservationState(installation) {
  await requireVolumes(installation.config);
  const code = "import{open}from'node:fs/promises';import{constants}from'node:fs';const f=await open('/data/state.json',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await f.stat();if(!s.isFile()||s.nlink!==1||s.size>4*1024**2)throw Error('state bound');const b=await f.readFile();if(b.length>4*1024**2)throw Error('state bound');process.stdout.write(b);}finally{await f.close();}";
  try {
    const text = await volumeHelper(installation.entry.image, installation.config.volumes.controller.name, ['--input-type=module', '-e', code], { entrypoint: '/usr/local/bin/node', capabilities: [], timeoutMs: 15000 });
    if (Buffer.byteLength(text) > 4 * 1024 ** 2) throw new Error();
    return JSON.parse(text);
  } catch { throw new Error('Cannot read local controller state; native readiness is unknown'); }
}
export async function observationNetwork(installation, fleet) {
  const { config, entry } = installation;
  const attachments = fleet.nodes.map(node => Object.keys(config.services[node.host].networks));
  if (!attachments.every(value => value.length === 1 && value[0] === attachments[0][0])) throw new Error('Observed fleet has inconsistent private network attachments');
  const role = attachments[0][0];
  const network = config.networks[role]?.name;
  if (!network) throw new Error('Observed fleet has no installed private network');
  const networks = await json(['network', 'inspect', network]);
  if (networks.length !== 1 || networks[0].Labels?.['com.docker.compose.project'] !== installation.project || networks[0].Labels?.['com.docker.compose.network'] !== role) throw new Error('Observed network does not belong to the selected installation');
  const containers = await projectContainers(installation.project);
  assertFleetContainers(containers, fleet, entry);
  return { network, controller: controllerProcess(containers, entry) };
}
function assertFleetContainers(containers, fleet, entry) {
  for (const node of fleet.nodes) {
    const matches = containers.filter(value => value.Config.Labels?.['com.docker.compose.service'] === node.host);
    if (matches.length !== 1 || matches[0].Image !== entry.image || matches[0].Config.Image !== entry.image) throw new Error('Observed native container does not match its qualified image');
  }
}
function controllerProcess(containers, entry) {
  const controllers = containers.filter(value => value.Config.Labels?.['com.docker.compose.service'] === 'controller');
  if (controllers.length !== 1 || controllers[0].Image !== entry.image || controllers[0].Config.Image !== entry.image) return 'unconfirmed';
  const state = controllers[0].State;
  return state.Running && !state.Paused && !state.Restarting ? 'running' : 'not-running';
}
