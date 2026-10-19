// Both unresolved templates and verified snapshots use the same replica wiring.
// Callers choose identities and validate the input/output contracts.
export function addFleet(base, sourceId, slot, nodeIds) {
  const config = structuredClone(base), network = `fleet-${slot.id.slice(5)}`;
  for (const [i, letter] of ['a', 'b'].entries()) {
    const name = `${slot.id}-${letter}`, service = structuredClone(config.services[`${sourceId}-${letter}`]);
    service.environment.CELLD_BUCKET = `s3://${service.environment.FOGD_BUCKET}/${slot.prefix}`;
    service.environment.CELLD_NODE = nodeIds[i];
    const advertise = Array.isArray(service.command) ? service.command.indexOf('--advertise') : -1;
    if (advertise < 0) throw new Error('Replica template is missing its advertised address');
    service.command[advertise + 1] = `${slot.nodes[i]}:8081`;
    service.volumes = [{ type: 'volume', source: name, target: '/var/lib/celld', volume: {} }];
    service.networks = { [network]: null };
    config.services[name] = service;
    config.volumes[name] = {};
  }
  config.networks[network] = {};
  for (const name of ['minio', 'controller', 'workerd']) config.services[name].networks[network] = null;
  const slots = JSON.parse(config.services.controller.environment.FOGD_SLOTS);
  for (const name of ['controller', 'workerd']) config.services[name].environment.FOGD_SLOTS = JSON.stringify([...slots, slot]);
  return config;
}
