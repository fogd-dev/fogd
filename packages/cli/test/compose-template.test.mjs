import test from 'node:test';
import assert from 'node:assert/strict';
import { extendTemplate, fleetCount } from '../src/compose/template.mjs';


function base() {
  const slots = JSON.stringify([1, 2].map(n => ({ id: `slot-${n}`, prefix: `slots/slot-${n}`, nodes: [`slot-${n}-a`, `slot-${n}-b`] })));
  const common = { environment: { FOGD_SLOTS: slots, FOGD_ADMIN_PASSWORD: '${FOGD_ADMIN_PASSWORD:?required}' }, networks: { control: null, 'fleet-1': null, 'fleet-2': null } };
  return { services: { controller: structuredClone(common), workerd: structuredClone(common), minio: structuredClone(common), ...Object.fromEntries(['a', 'b'].map(letter => [`slot-2-${letter}`, { environment: { FOGD_BUCKET: '${FOGD_BUCKET:-fogd}', KEEP: 'sentinel' }, command: ['--advertise', 'slot-2:8081'], mem_limit: '${FOGD_CELLD_MEMORY:-512m}' }])) }, volumes: {}, networks: {} };
}
test('third fleet retains source resource limits and runtime environment substitution', () => {
  const source = base(), original = structuredClone(source), config = extendTemplate(source, 3);
  assert.deepEqual(source, original);
  assert.deepEqual(config.services['slot-3-a'].networks, { 'fleet-3': null });
  assert.equal(config.services['slot-3-b'].volumes[0].source, 'slot-3-b');
  assert.equal(config.services['slot-3-a'].mem_limit, source.services['slot-2-a'].mem_limit);
  assert.equal(config.services['slot-3-a'].environment.KEEP, 'sentinel');
  assert.equal(config.services.controller.environment.FOGD_SLOTS, config.services.workerd.environment.FOGD_SLOTS);
  assert.equal(JSON.parse(config.services.controller.environment.FOGD_SLOTS).length, 3);
  assert.match(config.services['slot-3-a'].environment.CELLD_NODE, /FOGD_SLOT_3_A_ID/);
  assert.match(config.services.controller.environment.FOGD_ADMIN_PASSWORD, /\$\{FOGD_ADMIN_PASSWORD:/);
  assert.match(config.name, /COMPOSE_PROJECT_NAME/);
  for (const value of [0, 1, 4, '03', '3.0', '', undefined]) assert.throws(() => fleetCount(value), /2 or 3/);
});

test('rendering removes derived volume/network names and refuses explicit external names', () => {
  const source = base(); source.name = 'normalized-project';
  source.volumes.bucket = { name: 'normalized-project_bucket' };
  source.networks.control = { name: 'normalized-project_control' };
  const result = extendTemplate(source, 3);
  assert.equal(result.volumes.bucket.name, undefined);
  assert.equal(result.networks.control.name, undefined);
  source.volumes.bucket.name = 'other-installation-data';
  assert.throws(() => extendTemplate(source, 3), /project-owned/);
});
test('fleet selection refuses both expansion and shrink against retained resources', async () => {
  const { assertReplicaSelection } = await import('../src/compose/selection.mjs');
  const two = ['slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b'];
  const three = [...two, 'slot-3-a', 'slot-3-b'];
  assertReplicaSelection(two, []);
  assertReplicaSelection(two, ['controller', ...two, ...two]);
  assert.throws(() => assertReplicaSelection(three, two), /different fleet layout/);
  assert.throws(() => assertReplicaSelection(two, three), /different fleet layout/);
});

test('Kubernetes rejects Docker fleet-selection options before rendering', async () => {
  const { kubernetesCommand } = await import('../src/kubernetes/commands.mjs');
  await assert.rejects(kubernetesCommand(['render', 'unused', '--cert', 'unused', '--key', 'unused', '--fleets', '3']), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
});
