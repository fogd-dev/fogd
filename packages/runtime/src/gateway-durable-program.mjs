import { mkdtemp, realpath, lstat, copyFile, writeFile, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { durableGatewayConfig, durableGatewayModules } from './gateway-durable-config.mjs';
import { validateKeypair } from './transport.mjs';

function contains(parent, child) {
  const path = relative(parent, child);
  return !path || path !== '..' && !path.startsWith('..' + sep);
}
// The launch coordinator must independently verify the sealed policy and actual
// mounts before using this preparer. It does not start or admit a runtime.
export async function prepareDurableGateway(parent, options) {
  const tls = options.tls ? validateKeypair(options.tls) : null;
  const [runtimeParent, authority] = await Promise.all([realpath(parent), realpath(options.authorityPath)]);
  if (!(await lstat(authority)).isDirectory() || contains(authority, runtimeParent)) throw new Error('Gateway program must be separate from its authority directory');
  const config = durableGatewayConfig({ ...options, authorityPath: authority, tls: Boolean(tls) });
  const directory = await mkdtemp(join(runtimeParent, 'gateway-'));
  try {
    for (const name of durableGatewayModules) await copyFile(new URL(`./${name}`, import.meta.url), join(directory, name));
    if (tls) {
      await writeFile(join(directory, 'key.pem'), tls.key, { mode: 0o600, flag: 'wx' });
      await writeFile(join(directory, 'cert.pem'), tls.cert, { mode: 0o600, flag: 'wx' });
    }
    const path = join(directory, 'gateway.capnp'); await writeFile(path, config, { mode: 0o600, flag: 'wx' });
    return { directory, path };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
