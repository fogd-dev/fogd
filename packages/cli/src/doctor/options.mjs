import { parseArgs } from 'node:util';

export function doctorOptions(args, host = false) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, project: { type: 'string' }, name: { type: 'string' }, online: { type: 'boolean' }, json: { type: 'boolean' },
    ...(host ? { runtime: { type: 'string' }, installation: { type: 'string' }, 'against-installation': { type: 'string' }, server: { type: 'string' } } : {}),
  } });
  const modes = ['config', 'project', ...(host ? ['runtime', 'installation'] : [])].filter(key => values[key] !== undefined);
  const against = values['against-installation'];
  if ((against !== undefined && (!against || !values.project || values.online !== undefined)) || positionals.length || modes.length !== 1 || !values[modes[0]] || !validMode(values, modes[0])) {
    throw new Error(`Usage: fogd doctor ${host ? '--runtime FAMILY | --installation PROJECT [--server HTTPS_ORIGIN [--online]] | ' : ''}(--config FILE | --project DIR) --name APP [--online] [--json]${host ? ' [--against-installation PROJECT]' : ''}`);
  }
  return values;
}

function validMode(values, mode) {
  if (values.server !== undefined && (mode !== 'installation' || !values.server)) return false;
  if (mode === 'installation') return values.name === undefined && (values.online === undefined || Boolean(values.server));
  if (mode === 'runtime') return values.name === undefined && values.online === undefined;
  return Boolean(values.name);
}
