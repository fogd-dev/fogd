import { parseArgs } from 'node:util';

export function doctorOptions(args, host = false) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, project: { type: 'string' }, name: { type: 'string' }, online: { type: 'boolean' }, json: { type: 'boolean' },
    ...(host ? { runtime: { type: 'string' }, installation: { type: 'string' }, 'against-installation': { type: 'string' } } : {}),
  } });
  const modes = ['config', 'project', ...(host ? ['runtime', 'installation'] : [])].filter(key => values[key] !== undefined);
  const against = values['against-installation'];
  if ((against !== undefined && (!against || !values.project || values.online !== undefined)) || positionals.length || modes.length !== 1 || !values[modes[0]] || (['runtime', 'installation'].includes(modes[0])
    ? values.name !== undefined || values.online !== undefined : !values.name)) {
    throw new Error(`Usage: fogd doctor ${host ? '--runtime FAMILY | --installation PROJECT | ' : ''}(--config FILE | --project DIR) --name APP [--online] [--json]${host ? ' [--against-installation PROJECT]' : ''}`);
  }
  return values;
}
