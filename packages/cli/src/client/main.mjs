import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const help = 'node fogd.mjs deploy [--name APP]  Build the current Void app and submit for approval\nnode fogd.mjs status ID           Read a submission with its deploy credential\nnode fogd.mjs doctor --config FILE --name APP [--online] [--json]  Check JSON declarations without building\n\nRequires Node.js 24.21 or newer. Set FOGD_SERVER and FOGD_DEPLOY_TOKEN for network commands.\nFOGD_ENV_FILE selects an optional profile. Operator FOGD_HOME is ignored.\nLocal builds use FOGD_CLIENT_HOME (default: $XDG_STATE_HOME/fogd-client or ~/.local/state/fogd-client).';

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 21)) throw new Error('Developer client requires Node.js 24.21 or newer');
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help'].includes(command)) {
    if (args.length) throw new Error('Help takes no arguments');
    console.log(help);
  } else await runClient(command, args);
} catch (error) { console.error(`fogd: ${error.message}`); process.exitCode = 1; }

async function runClient(command, args) {
  const name = argumentsFor(command, args);
  // Establish the developer's state location before importing shared commands,
  // whose module-level home also serves the operator CLI.
  process.env.FOGD_HOME = resolve(process.env.FOGD_CLIENT_HOME || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'fogd-client'));
  if (command === 'doctor') return (await import('../doctor/application-command.mjs')).applicationDoctorCommand(args);
  const { configEnv } = await import('../local.mjs');
  const env = await configEnv();
  if (!env.FOGD_SERVER || !env.FOGD_DEPLOY_TOKEN) throw new Error('Set FOGD_SERVER and FOGD_DEPLOY_TOKEN for this installation');
  const { controllerOrigin } = await import('../build-cache/paths.mjs');
  process.env.FOGD_SERVER = controllerOrigin(env.FOGD_SERVER);
  process.env.FOGD_DEPLOY_TOKEN = env.FOGD_DEPLOY_TOKEN;
  if (command === 'status') return (await import('../status-command.mjs')).status(args[0]);
  await mkdir(process.env.FOGD_HOME, { recursive: true, mode: 0o700 });
  await (await import('../deploy-command.mjs')).deploy(process.cwd(), name);
}

function argumentsFor(command, args) {
  if (command === 'doctor') return;
  if (command === 'status') {
    if (args.length !== 1) throw new Error('Usage: node fogd.mjs status ID');
    return;
  }
  if (command !== 'deploy') throw new Error('Developer client supports deploy, status and application doctor; use the operator CLI for installation and administration');
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { name: { type: 'string' } } });
  if (positionals.length || values.name === '') throw new Error('Usage: fogd deploy [--name APP]');
  return values.name;
}
