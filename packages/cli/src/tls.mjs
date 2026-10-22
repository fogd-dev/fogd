import { assertSharedStorageConfiguration } from './shared-storage.mjs';
import { maintenanceConfiguration } from './runtime/maintenance.mjs';
import { checkFleetSelection } from './compose/selection.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateKeypair } from '@fogd/runtime/transport';
import { requireDocker, compose, configEnv } from './local.mjs';
import { prepareEnvironment } from './bootstrap.mjs';
import { docker, json, stopped } from './recovery/docker.mjs';
import { selectedInstallation } from './runtime/installation.mjs';

async function installation(env, project) {
  requireDocker(env);
  const config = await maintenanceConfiguration(env, project);
  assertSharedStorageConfiguration(config);
  await checkFleetSelection(config);
  if (!config.volumes?.tls?.name) throw new Error('This installation needs the TLS-volume configuration before certificate import');
  return config;
}
const helper = (config, readonly) => ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--mount', `type=volume,src=${config.volumes.tls.name},dst=/var/lib/fogd-tls${readonly ? ',readonly' : ''}`, '--entrypoint', '/usr/local/bin/node', config.services.controller.image];
export async function importTLS(certPath, keyPath, project) {
  const cert = await readFile(resolve(certPath), 'utf8'), key = await readFile(resolve(keyPath), 'utf8');
  validateKeypair({ cert, key });
  const env = project === undefined ? await prepareEnvironment() : await configEnv(), raw = await installation(env, project);
  await stopped(raw.name, Object.values(raw.volumes).map(volume => volume.name));
  const selected = await selectedInstallation(raw), config = selected?.config || raw;
  if (project !== undefined && !selected) throw new Error('Explicit certificate import requires its independent runtime policy; legacy fallback is refused');
  if (selected) {
    if (project === undefined) await docker([...selected.command, 'create', '--pull', 'never']);
  } else { await compose(['build'], env); await compose(['create', '--pull', 'never'], env); }
  const args = helper(config, false); args.splice(1, 0, '-i');
  const result = await docker([...args, 'packages/runtime/src/import-tls.mjs'], { inputText: JSON.stringify({ cert, key }) });
  console.log(result.trim());
  console.log(selected ? `Certificate installed. Start with fogd up --installation ${config.name}.` : 'Certificate installed. Start with fogd up --shared to require TLS and scoped deployment credentials.');
}
export async function checkInstalledTLS(env, config = null) {
  config ||= await installation(env);
  try {
    await json(['volume', 'inspect', config.volumes.tls.name]);
    const args = helper(config, true); args.splice(args.length - 1, 0, '--env', 'FOGD_TLS=1');
    await docker([...args, '--input-type=module', '-e', "import {loadTLS} from './packages/runtime/src/transport.mjs'; await loadTLS(process.env);"]);
  } catch { throw new Error('Installed TLS keypair could not be validated; run fogd tls import CERT KEY while stopped'); }
}
