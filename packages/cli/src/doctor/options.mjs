import { parseArgs } from 'node:util';

export function doctorOptions(args, host = false) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, project: { type: 'string' }, name: { type: 'string' }, online: { type: 'boolean' }, json: { type: 'boolean' },
    ...(host ? { runtime: { type: 'string' } } : {}),
  } });
  const modes = ['config', 'project', ...(host ? ['runtime'] : [])].filter(key => values[key] !== undefined);
  if (positionals.length || modes.length !== 1 || !values[modes[0]] || (modes[0] === 'runtime'
    ? values.name !== undefined || values.online !== undefined : !values.name)) {
    throw new Error(`Usage: fogd doctor ${host ? '--runtime FAMILY | ' : ''}(--config FILE | --project DIR) --name APP [--online] [--json]`);
  }
  return values;
}
