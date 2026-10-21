// Native celld validates the expression grammar at deployment. Keep the exact
// expression text: it participates in occurrence/retry identity.
export function translateTriggers(input, capabilities) {
  if (input == null || input === false || input === '') return undefined;
  if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'crons')) throw new Error('Unsupported scheduled trigger options');
  if (Object.keys(input).length === 0 || input.crons == null) return undefined;
  if (!Array.isArray(input.crons)) throw new Error('Invalid cron declarations');
  if (!input.crons.length) return undefined;
  if (capabilities?.cronApps !== true) throw new Error('Unsupported binding/config: triggers; scheduled applications require a selected runtime');
  assertCronExpressions(input.crons);
  return { crons: [...input.crons] };
}

function assertCronExpressions(crons) {
  if (crons.length > 16 || crons.some(value => typeof value !== 'string' || !value.length || value.length > 256 ||
    value !== value.trim() || !/^[\x20-\x7e]+$/.test(value)) || new Set(crons).size !== crons.length) throw new Error('Invalid cron declarations');
}
