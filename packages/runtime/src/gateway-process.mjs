import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { constants } from 'node:os';
import { transportPolicy, loadTLS } from './transport.mjs';
import { prepareDurableGateway } from './gateway-durable-program.mjs';
import { readGatewayLaunchPolicy, validateGatewayLaunchPolicy, gatewayAuthorityDirectory } from './gateway-launch-policy.mjs';
import { assertGatewayExecutable, gatewayExecutable } from './gateway-executable.mjs';

const failed = () => Object.assign(new Error('Durable gateway startup or execution failed; keep ingress stopped'), { code: 'GATEWAY_PROCESS_FAILED' });
const signalled = signal => ({ code: 128 + (constants.signals[signal] || 0), signal });

function shutdownSignals(signals) {
  let child, requested;
  const handlers = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal, () => { requested ||= signal; child?.kill(signal); }]));
  for (const [name, handler] of handlers) signals.on(name, handler);
  return {
    get requested() { return requested; },
    forward(value) { child = value; if (requested) child.kill(requested); },
    closed() { child = null; },
    dispose() { for (const [name, handler] of handlers) signals.off(name, handler); },
  };
}
function supervise(child, shutdown) {
  return new Promise((resolve, reject) => {
    let error;
    child.on('error', value => { error = value; });
    // An error may describe a failed kill while the process is still live. Only
    // close confirms terminal state and permits removing its program/key files.
    child.once('close', (code, signal) => {
      shutdown.closed();
      if (error) reject(failed());
      else resolve({ code: code ?? signalled(signal).code, signal });
    });
    shutdown.forward(child);
  });
}

// Trusted launcher seams are programmatic only. The installed JSON cannot choose
// a binary, path, environment, listen address, TLS source or process supervisor.
export async function runDurableGateway({ env = process.env, readPolicy = readGatewayLaunchPolicy,
  authorityPath = gatewayAuthorityDirectory, parent = '/tmp', checkExecutable = assertGatewayExecutable,
  prepareProgram = prepareDurableGateway, spawnChild = spawn, signals = process } = {}) {
  const shutdown = shutdownSignals(signals); let program;
  try {
    transportPolicy(env);
    const plan = validateGatewayLaunchPolicy(await readPolicy());
    if (shutdown.requested) return signalled(shutdown.requested);
    const tls = await loadTLS(env);
    if (shutdown.requested) return signalled(shutdown.requested);
    await checkExecutable();
    if (shutdown.requested) return signalled(shutdown.requested);
    program = await prepareProgram(parent, { policy: plan.policy, slots: plan.slots, authorityPath, listen: '*:8080', tls });
    if (shutdown.requested) return signalled(shutdown.requested);
    try {
      const child = spawnChild(gatewayExecutable, ['serve', program.path], { stdio: 'inherit', env: {} });
      return await supervise(child, shutdown);
    } catch { throw failed(); }
  } finally {
    try { if (program) await rm(program.directory, { recursive: true, force: true }); }
    finally { shutdown.dispose(); }
  }
}
