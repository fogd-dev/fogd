import { DispatchControl, initialControl, validateControl } from './dispatch-control.mjs';

export const cronUpdateNotice = 'An update can interrupt scheduled work already in flight. Pause does not drain it. Check the application for unfinished work; do not rely on automatic replay.';
export const cronCapability = 'fogd-cron-activation-v1';
export const cronRetirementCapability = 'fogd-cron-retirement-v1';
const contract = { identity: 'script', pattern: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, noun: 'cron dispatch', title: 'Cron dispatch', outcomeCode: 'CRON_OUTCOME_UNKNOWN', validate: validateCronDispatch };

export function initialCronDispatch(script, activation) { return initialControl(script, activation, contract); }
export function validateCronDispatch(state) { validateControl(state, contract); }
export class CronDispatch extends DispatchControl {
  constructor(options) { super({ ...options, contract }); }
}

export function cronScript(resources) {
  if (!Object.hasOwn(resources, 'crons')) return null;
  if (!Array.isArray(resources.crons) || !resources.crons.length || !resources.crons.every(value => typeof value === 'string' && value.trim().length > 0)) throw new Error('Invalid cron declarations');
  if (typeof resources.script !== 'string' || !contract.pattern.test(resources.script)) throw new Error('Invalid cron script identity');
  if (resources.queues) throw new Error('Combined cron and queue activation is not qualified');
  return resources.script;
}

export function requireCronCapability(state, resources) {
  if (cronScript(resources)) state.requirements = [...new Set([...(state.requirements || []), cronCapability])];
}
