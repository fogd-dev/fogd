import { isDeepStrictEqual } from 'node:util';
import { labels } from '../resources.mjs';
import { counts } from './contract.mjs';

export function validateShape(desired, topology) {
  if (desired.kind !== 'List' || desired.items.some(r => !['StatefulSet', 'Service'].includes(r.kind))) throw new Error('Unsupported Kubernetes recovery resources');
  const sets = desired.items.filter(r => r.kind === 'StatefulSet');
  if (!isDeepStrictEqual(sets.map(s => s.metadata.name).sort(), Object.keys(counts).sort())) throw new Error('Unsupported stateful topology');
  for (const set of sets) validateSet(set, topology);
  for (const service of desired.items.filter(r => r.kind === 'Service')) validateService(service, topology);
}
function validateSet(set, topology) {
  const name = set.metadata.name, pod = set.spec.template.spec;
  if (set.metadata.namespace !== topology.namespace || set.spec.replicas !== counts[name] || set.spec.updateStrategy.type !== 'OnDelete' || pod.containers.length !== 1) throw new Error('Unsupported writer configuration');
  validatePod(name, pod, topology);
  const main = pod.containers[0], image = name === 'minio' ? topology.images.minio : topology.images.runtime;
  if (main.image !== image || main.imagePullPolicy !== 'Never') throw new Error('Unexpected workload image');
  validateMounts(name, main, pod, set.spec.volumeClaimTemplates);
  validateCommand(name, main);
  const endpoint = main.env?.find(e => e.name === 'S3_ENDPOINT');
  if (name !== 'minio' && endpoint?.value !== 'http://minio:9000') throw new Error('External bucket recovery is unsupported');
}

function validateMounts(name, main, pod, templates) {
  const path = name === 'minio' ? '/data' : name === 'controller' ? '/var/lib/fogd' : '/var/lib/celld';
  if (name !== 'workerd' && !main.volumeMounts.some(v => v.name === 'data' && v.mountPath === path && !v.subPath && !v.readOnly)) throw new Error('Unsupported durable data mount');
  if ((pod.volumes || []).some(v => !v.secret || v.secret.secretName !== 'fogd-tls') || (templates || []).some(c => c.metadata.name !== 'data')) throw new Error('Unsupported external storage');
  if (templates.length !== (name === 'workerd' ? 0 : 1)) throw new Error('Unsupported durable claim templates');
}

function validateCommand(name, main) {
  const expected = name === 'minio' ? undefined : name.startsWith('slot-') ? ['celld-supervisor'] : ['node', name === 'controller' ? 'packages/platform/src/main.mjs' : 'packages/runtime/src/serve.mjs'];
  if (!isDeepStrictEqual(main.command, expected)) throw new Error('Unexpected stateful process command');
  if (name.startsWith('slot-')) {
    if (!isDeepStrictEqual(main.args, ['--trust-forwarded-headers', '--listen', '0.0.0.0:8080', '--internal-listen', '0.0.0.0:8081', '--advertise', '$(CELLD_NODE):8081'])) throw new Error('Unexpected replica state configuration');
    if (main.env.find(e => e.name === 'CELLD_WATCH')?.value !== '/var/lib/celld/state') throw new Error('Unexpected replica data path');
  } else if (main.args !== undefined) throw new Error('Unexpected stateful process arguments');
  if (main.env.some(e => e.name === 'FOGD_DATA_DIR' && e.value !== '/var/lib/fogd')) throw new Error('Unexpected controller data path');
}

function validateService(service, topology) {
  const name = service.metadata.name, spec = service.spec;
  const replica = /^slot-[12]-[01]$/.test(name), fleet = /^slot-[12]$/.test(name);
  if (!replica && !Object.hasOwn(counts, name)) throw new Error('Unexpected routing Service');
  const selector = replica ? { ...labels(name.slice(0, -2)), 'statefulset.kubernetes.io/pod-name': name } : labels(name);
  if (service.metadata.namespace !== topology.namespace || !isDeepStrictEqual(spec.selector, selector)) throw new Error('Routing Service does not select its owned workload');
  if ((spec.type && spec.type !== 'ClusterIP') || spec.externalName || spec.externalIPs?.length || (fleet ? spec.clusterIP !== 'None' : spec.clusterIP !== undefined)) throw new Error('Unsupported external or unstable routing Service');
}

function validatePod(name, pod, topology) {
  if (pod.hostNetwork || pod.hostPID || pod.hostIPC || pod.automountServiceAccountToken !== false) throw new Error('Unsupported host or API access');
  const containers = [...pod.containers, ...(pod.initContainers || [])];
  if (containers.some(c => c.envFrom !== undefined)) throw new Error('Recovery requires explicit container environment entries');
  if (containers.some(c => c.securityContext?.privileged)) throw new Error('Privileged recovery workloads are unsupported');
  const initializers = pod.initContainers || [];
  const expected = name === 'controller' || name.startsWith('slot-') ? 1 : 0;
  if (initializers.length !== expected) throw new Error('Unexpected initializer inventory');
  for (const init of initializers) validateInitializer(init, topology);
}

function validateInitializer(init, topology) {
  if (init.image !== topology.images.runtime || !isDeepStrictEqual(init.command, ['node', 'packages/runtime/src/init-bucket.mjs']) || init.volumeMounts?.length) throw new Error('Unsupported initializer or writable initialization mount');
  if (init.env.find(e => e.name === 'S3_ENDPOINT')?.value !== 'http://minio:9000') throw new Error('External initialization bucket is unsupported');
}
