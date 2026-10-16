import { devNull } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateKeypair } from '@fogd/runtime/transport';
import { requireDocker, compose, stackRoot } from './local.mjs';
import { prepareEnvironment } from './bootstrap.mjs';
import { docker, json, projectContainers } from './recovery/docker.mjs';
import { composeResolved } from './recovery/bundle.mjs';

async function installation(env) {
  requireDocker(env);
  const file = resolve(env.FOGD_COMPOSE_FILE || join(stackRoot, 'compose.yaml'));
  const config = composeResolved(await json(['compose', '--env-file', devNull, '-f', file, 'config', '--format', 'json'], { env }));
  if (!config.volumes?.tls?.name) throw new Error('This installation needs the TLS-volume configuration before certificate import');
  return config;
}
const helper = (config, readonly) => ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--mount', `type=volume,src=${config.volumes.tls.name},dst=/var/lib/fogd-tls${readonly ? ',readonly' : ''}`, config.services.controller.image];
export async function importTLS(certPath, keyPath) {
  const cert = await readFile(resolve(certPath), 'utf8'), key = await readFile(resolve(keyPath), 'utf8');
  validateKeypair({ cert, key });
  const env = await prepareEnvironment(), config = await installation(env);
  if ((await projectContainers(config.name)).some(c => c.State.Running)) throw new Error('Stop this installation before importing or rotating its certificate');
  await compose(['build'], env);
  await compose(['create', '--pull', 'never'], env);
  const args = helper(config, false); args.splice(1, 0, '-i');
  const result = await docker([...args, 'node', 'packages/runtime/src/import-tls.mjs'], { inputText: JSON.stringify({ cert, key }) });
  console.log(result.trim());
  console.log('Certificate installed. Start with fogd up --shared to require TLS and scoped deployment credentials.');
}
export async function checkInstalledTLS(env) {
  const config = await installation(env);
  await json(['volume', 'inspect', config.volumes.tls.name]);
  const args = helper(config, true); args.splice(args.length - 1, 0, '--env', 'FOGD_TLS=1');
  await docker([...args, 'node', '--input-type=module', '-e', "import {loadTLS} from './packages/runtime/src/transport.mjs'; await loadTLS(process.env);"]);
}
