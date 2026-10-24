import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { prepareRouteRestoration, prepareRetiredRouteRestoration } from '@fogd/platform/route-restoration';
import { encodeRouteRecord } from '@fogd/runtime/route-record';
import { docker } from '../recovery/docker.mjs';
import { durableRuntimeConfig } from './durable-config.mjs';
import { durableRouteHelperArgs } from './durable-route-helper.mjs';

const refused = () => Object.assign(new Error('Stopped route restoration requires a checked source pair and sealed destination profile; nothing was started'), { code: 'DURABLE_RESTORATION_REFUSED' });
const uncertain = () => Object.assign(new Error('Stopped route restoration is unconfirmed; keep source and destination stopped and retain all enrollment records and stores'), { code: 'DURABLE_RESTORATION_UNCERTAIN' });
const operations = { restore: prepareRouteRestoration, retire: prepareRetiredRouteRestoration };
function restorationPlan(config, input, operation) {
  if (!isDeepStrictEqual(config, durableRuntimeConfig(config, input.profile))) throw refused();
  if (input.domain !== (config.services.controller.environment.FOGD_BASE_DOMAIN || 'localhost')) throw refused();
  const { record } = operations[operation](input), policy = { installation: runtimePolicyIdentity(input.profile), slots: input.profile.fleets.map(fleet => fleet.id) };
  const sha256 = createHash('sha256').update(encodeRouteRecord(record, policy)).digest('hex');
  const text = JSON.stringify(input);
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw refused();
  return { text, args: durableRouteHelperArgs(config, input.profile.image, operation),
    receipt: { installation: policy.installation, binding: input.binding, snapshot: input.snapshot, revision: '1', sha256 } };
}
function checkedReceipt(output, receipt) {
  if (typeof output !== 'string' || output.length > 1024 || !/^[\x20-\x7e]+\n?$/.test(output)) throw uncertain();
  const result = JSON.parse(output), expected = { id: result?.id, ...receipt };
  if (typeof result?.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(result.id) || !isDeepStrictEqual(result, expected)) throw uncertain();
  return result;
}

// The host owns fresh allocation, source exclusion, verified images, terminal
// copy helpers and incomplete host enrollment. This adapter opens no listener.
export async function restoreDurableRoutes(config, input, options) {
  return restoreRoutes(config, input, 'restore', options);
}
export async function retireDurableRoutes(config, input, options) {
  return restoreRoutes(config, input, 'retire', options);
}
async function restoreRoutes(config, input, operation, { run = docker } = {}) {
  let plan;
  try { plan = restorationPlan(config, input, operation); } catch { throw refused(); }
  try { return checkedReceipt(await run(plan.args, { inputText: plan.text }), plan.receipt); }
  catch { throw uncertain(); }
}
