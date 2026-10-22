import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stageManagedBuild, submitManagedBuild } from '../../src/build-cache/lifecycle.mjs';

export const origin = 'http://127.0.0.1:9876';
export async function buildFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'fogd-build-cache-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, 'project');
  await mkdir(join(project, 'dist/ssr'), { recursive: true });
  await writeFile(join(project, 'dist/ssr/index.js'), 'export default {fetch(){return new Response("cache fixture")}}');
  await writeFile(join(project, 'dist/ssr/wrangler.json'), JSON.stringify({ main: 'index.js' }));
  const release = await stageManagedBuild(home, { app: 'cache-test', project, settings: {} });
  const root = join(home, '.fogd/build-cache/cache-test', release.localBuildId);
  return { home, project, release, root };
}
export async function submittedFixture(t, status = 'superseded') {
  const fixture = await buildFixture(t), id = randomUUID();
  const result = { id, app: fixture.release.app, digest: fixture.release.digest, status: 'pending' };
  await submitManagedBuild(fixture.home, fixture.release, origin, async () => result);
  return { ...fixture, state: { apps: {}, deployments: { [id]: { ...result, status } } }, id };
}
