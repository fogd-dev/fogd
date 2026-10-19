import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { stackRoot } from '../packages/cli/src/local.mjs';
import { dockerCommand } from '../packages/cli/src/compose/render.mjs';
import { json } from '../packages/cli/src/recovery/docker.mjs';
import { validateTopology } from '../packages/cli/src/recovery/bundle.mjs';

await mkdir(join(stackRoot, '.fogd'), { recursive: true });
const dir = await mkdtemp(join(stackRoot, '.fogd', 'render-check-'));
const sentinel = 'render-check-private-sentinel';
const previous = process.env.FOGD_ADMIN_PASSWORD;
process.env.FOGD_ADMIN_PASSWORD = sentinel;
try {
  for (const count of [2, 3]) await dockerCommand(['render', join(dir, String(count)), '--fleets', String(count)]);
  const before = await readFile(join(dir, '3', 'compose.json'), 'utf8');
  assert.ok(!before.includes(sentinel));
  await assert.rejects(dockerCommand(['render', join(dir, '3'), '--fleets', '2']), { code: 'EEXIST' });
  assert.equal(await readFile(join(dir, '3', 'compose.json'), 'utf8'), before);
  for (const project of ['fogd-render-proof-a', 'fogd-render-proof-b']) {
    const original = await resolved(join(stackRoot, 'compose.yaml'), project);
    for (const key of Object.keys(original)) if (key.startsWith('x-')) delete original[key];
    assert.deepEqual(await resolved(join(dir, '2', 'compose.json'), project), original);
    const three = await resolved(join(dir, '3', 'compose.json'), project);
    validateTopology(three);
    assert.equal(Object.keys(three.services).length, 10);
    for (const kind of ['volumes', 'networks']) for (const [name, item] of Object.entries(three[kind])) assert.equal(item.name, `${project}_${name}`);
  }
  console.log('PASS: two-fleet equivalence, three-fleet topology, isolated project resources, no credential capture, and occupied-output refusal');
} finally {
  if (previous === undefined) delete process.env.FOGD_ADMIN_PASSWORD; else process.env.FOGD_ADMIN_PASSWORD = previous;
  await rm(dir, { recursive: true });
}
function resolved(file, project) {
  return json(['compose', '--env-file', '/dev/null', '--project-directory', stackRoot, '-f', file, 'config', '--format', 'json'], { env: { ...process.env, COMPOSE_PROJECT_NAME: project, FOGD_GATEWAY_TOKEN: 'test-gateway', FOGD_ADMIN_PASSWORD: sentinel } });
}
