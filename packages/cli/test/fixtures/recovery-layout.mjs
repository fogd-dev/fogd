export const replicas = ['slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b'];
export const services = ['bucket-init', 'controller', 'minio', ...replicas, 'workerd'];
export const volumes = ['bucket', 'controller', ...replicas];
export const slots = [1, 2].map(n => ({ id: `slot-${n}`, prefix: `slots/slot-${n}`, nodes: [`slot-${n}-a`, `slot-${n}-b`] }));
export function config() {
  const shared = { control: {}, 'fleet-1': {}, 'fleet-2': {} };
  const result = { name: 'original', services: Object.fromEntries(services.map(name => [name, { image: 'mutable:tag', build: '.', environment: { FOGD_BUCKET: 'fogd', FOGD_SLOTS: JSON.stringify(slots), S3_ENDPOINT: 'http://minio:9000', TOKEN: 'literal$VALUE${HOME}' }, networks: shared }])), volumes: Object.fromEntries(volumes.map(name => [name, { name: `original_${name}` }])), networks: Object.fromEntries(Object.keys(shared).map(name => [name, { name: `original_${name}` }])) };
  result.services['bucket-init'].networks = { control: {} };
  for (const name of replicas) {
    const slot = name.slice(0, -2);
    Object.assign(result.services[name].environment, { CELLD_NODE: name, CELLD_BUCKET: `s3://fogd/slots/${slot}` });
    result.services[name].command = ['--advertise', `${name}:8081`];
    result.services[name].networks = { [`fleet-${slot.slice(5)}`]: {} };
    result.services[name].volumes = [{ type: 'volume', source: name, target: '/var/lib/celld' }];
  }
  result.services.controller.volumes = [{ type: 'volume', source: 'controller', target: '/var/lib/fogd' }];
  result.services.minio.volumes = [{ type: 'volume', source: 'bucket', target: '/data' }];
  return result;
}
