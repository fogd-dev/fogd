import { transportPolicy, loadTLS } from '@fogd/runtime/transport';
import { Controller } from './controller.mjs';
import { Backend } from './backend.mjs';
import { backendCronRuntime } from './backend-runtime-identity.mjs';
import { installedRuntimePolicy } from './runtime-policy-file.mjs';
import { validateRuntimePolicy, RuntimePolicyError } from './runtime-policy.mjs';
import { server } from './http.mjs';

const required = key => { const value = process.env[key]; if (!value) throw new Error(`${key} is required; run fogd up to initialize local credentials`); return value; };
function configuredSlots() {
  const slots = JSON.parse(required('FOGD_SLOTS'));
  if (!Array.isArray(slots) || !slots.length || new Set(slots.map(s => s.id)).size !== slots.length || new Set(slots.map(s => s.prefix)).size !== slots.length) throw new Error('Invalid fleet slots');
  slots.forEach(validateSlot);
  return slots;
}
function validateSlot(slot) {
  if (!/^[a-z0-9-]+$/.test(slot.id) || !/^[a-z0-9/-]+$/.test(slot.prefix) || slot.prefix.split('/').some(p => !p || p === '..') || slot.nodes.length !== 2 || slot.nodes.some(n => !/^[a-z0-9.-]+$/.test(n))) throw new Error('Invalid fleet configuration');
}
function controllerOptions(backend) {
  const slots = configuredSlots();
  if (!['0', '1'].includes(process.env.FOGD_QUEUE_APPS || '0')) throw new Error('FOGD_QUEUE_APPS must be 0 or 1');
  return { queueApps: process.env.FOGD_QUEUE_APPS === '1', dir: process.env.FOGD_DATA_DIR || '/var/lib/fogd', slots, backend, baseDomain: process.env.FOGD_BASE_DOMAIN || 'localhost', maxPending: process.env.FOGD_MAX_PENDING ?? 20, maxPendingPerCredential: process.env.FOGD_MAX_PENDING_PER_CREDENTIAL ?? 5, maxArtifactBytes: process.env.FOGD_MAX_ARTIFACT_BYTES ?? 268435456 };
}

export function selectedBackend(backend, policy, env) {
  if (policy === null || policy === undefined) return backend ?? new Backend(env);
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new RuntimePolicyError();
  const expected = validateRuntimePolicy(policy, env);
  if (backend !== undefined && backend !== null) throw new Error('Injected backend conflicts with installed runtime policy');
  const selected = new Backend(env);
  selected.crons = backendCronRuntime(selected, expected);
  return selected;
}

// A dedicated host-written policy selects the guarded transport. Without it,
// existing installations and private backend composition retain their behavior.
// Artifact admission remains separately controlled by the controller.
export async function startController(backend, { readPolicy = installedRuntimePolicy, cronApps = false } = {}) {
  transportPolicy(process.env);
  const tls = await loadTLS(process.env);
  const credentials = { user: required('FOGD_ADMIN_USER'), password: required('FOGD_ADMIN_PASSWORD'), deploy: process.env.FOGD_DEPLOY_TOKEN || null, gateway: required('FOGD_GATEWAY_TOKEN') };
  const options = controllerOptions(backend);
  const policy = await readPolicy(process.env);
  options.backend = selectedBackend(options.backend, policy, process.env);
  options.cronApps = policy ? true : cronApps;
  const controller = new Controller(options);
  await controller.init();
  const http = server(controller, credentials, { maxUploads: process.env.FOGD_MAX_UPLOADS ?? 2, tls });
  http.listen(Number(process.env.FOGD_CONTROL_PORT || 8082), process.env.FOGD_CONTROL_BIND || '0.0.0.0', () => console.log('fogd approval controller ready'));
  const internal = server(controller, credentials, { role: 'internal' });
  internal.listen(Number(process.env.FOGD_INTERNAL_PORT || 8083), process.env.FOGD_CONTROL_BIND || '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { http.close(); internal.close(); setTimeout(() => process.exit(), 30000).unref(); });
  return { controller, http, internal };
}
