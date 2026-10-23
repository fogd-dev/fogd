import { mkdir, lstat, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { RoutePublication } from '../../src/route-publication.mjs';
import { writeAtomicFile } from '../../src/atomic-file.mjs';

// Component fixtures seed protocol data explicitly. Production Controller startup
// never initializes authority; its stopped initializer must spend enrollment first.
export async function seedRouteStores(dir, options) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const identity = async path => {
    const stat = await lstat(path, { bigint: true });
    return { path: await realpath(path), device: stat.dev.toString(), inode: stat.ino.toString() };
  };
  const state = { apps: {}, deployments: {}, routeEnrollment: { controller: await identity(dir), authority: await identity(dirname(options.path)) } }; let first = true;
  const publication = new RoutePublication({ ...options, state, domain: 'localhost', async savePrivate() {
    await writeAtomicFile(join(dir, 'state.json'), JSON.stringify(state, null, 2), { createOnly: first, createDirectory: false }); first = false;
  } });
  await publication.initialize();
}
