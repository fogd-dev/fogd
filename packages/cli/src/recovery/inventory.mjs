import { isDeepStrictEqual } from 'node:util';
import { json, projectContainers, services, volumes } from './docker.mjs';

export function checkContainer(service, container, image) {
  const actual = Object.fromEntries(container.Config.Env.map(entry => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
  for (const [key, value] of Object.entries(service.environment || {})) {
    if (actual[key] !== String(value)) throw new Error('Running configuration differs from Compose; restore its original configuration before backup');
  }
  for (const [field, key] of [['Cmd', 'command'], ['Entrypoint', 'entrypoint']]) {
    if (!isDeepStrictEqual(container.Config[field], service[key] ?? image.Config[field])) throw new Error('Running command differs from Compose');
  }
}
export async function inventory(config) {
  const containers = await projectContainers(config.name);
  const images = {};
  for (const name of services) {
    const found = containers.filter(c => c.Config.Labels['com.docker.compose.service'] === name);
    if (found.length !== 1) throw new Error(`Expected exactly one ${name} container; run fogd up first`);
    const container = found[0], service = config.services[name];
    images[name] = container.Image;
    const [image] = await json(['image', 'inspect', container.Image]);
    checkContainer(service, container, image);
    const expected = (service.volumes || []).map(m => [config.volumes[m.source].name, m.target]).sort();
    const actual = container.Mounts.map(m => [m.Type === 'volume' ? m.Name : null, m.Destination]).sort();
    if (!isDeepStrictEqual(expected, actual)) throw new Error('Container volumes do not match the resolved configuration');
  }
  if (containers.length !== services.length) throw new Error('Unexpected project containers');
  for (const name of volumes) {
    const [volume] = await json(['volume', 'inspect', config.volumes[name].name]);
    if (volume.Labels?.['com.docker.compose.project'] !== config.name || volume.Labels?.['com.docker.compose.volume'] !== name || volume.Driver !== 'local' || Object.keys(volume.Options || {}).length) throw new Error('Volume is not owned local project storage');
  }
  return images;
}
