import { serviceNames, volumeNames } from './layout.mjs';
import { isDeepStrictEqual } from 'node:util';
import { json, projectContainers } from './docker.mjs';
import { checkIsolation, checkMounts } from './container-isolation.mjs';

export function checkContainer(service, container, image) {
  if (/^sha256:[a-f0-9]{64}$/.test(service.image || '') && container.Image !== service.image) throw new Error('Running image differs from the pinned Compose image');
  checkIsolation(service, container);
  const actual = Object.fromEntries(container.Config.Env.map(entry => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
  for (const [key, value] of Object.entries(service.environment || {})) {
    if (actual[key] !== String(value)) throw new Error('Running configuration differs from Compose; restore its original configuration before backup');
  }
  if (service.read_only) {
    const inherited = Object.fromEntries((image.Config.Env || []).map(entry => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
    const expected = { ...inherited, ...Object.fromEntries(Object.entries(service.environment || {}).map(([key, value]) => [key, String(value)])) };
    if (!isDeepStrictEqual(actual, expected)) throw new Error('Sealed container environment differs from Compose and the pinned image');
  }
  for (const [field, key] of [['Cmd', 'command'], ['Entrypoint', 'entrypoint']]) {
    if (!isDeepStrictEqual(container.Config[field], service[key] ?? image.Config[field])) throw new Error('Running command differs from Compose');
  }
}
export async function inventory(config) {
  const containers = await projectContainers(config.name);
  const images = {}, services = serviceNames(config);
  for (const name of services) {
    const found = containers.filter(c => c.Config.Labels['com.docker.compose.service'] === name);
    if (found.length !== 1) throw new Error(`Expected exactly one ${name} container; run fogd up first`);
    const container = found[0], service = config.services[name];
    images[name] = container.Image;
    const [image] = await json(['image', 'inspect', container.Image]);
    checkContainer(service, container, image);
    checkMounts(service, container, config.volumes);
  }
  if (containers.length !== services.length) throw new Error('Unexpected project containers');
  for (const name of volumeNames(config)) {
    const [volume] = await json(['volume', 'inspect', config.volumes[name].name]);
    if (volume.Labels?.['com.docker.compose.project'] !== config.name || volume.Labels?.['com.docker.compose.volume'] !== name || volume.Driver !== 'local' || Object.keys(volume.Options || {}).length) throw new Error('Volume is not owned local project storage');
  }
  return images;
}
