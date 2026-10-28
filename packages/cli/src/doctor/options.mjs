import { parseArgs } from 'node:util';

export function doctorOptions(args, host = false) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, name: { type: 'string' }, online: { type: 'boolean' }, json: { type: 'boolean' },
    ...(host ? { runtime: { type: 'string' } } : {}),
  } });
  const application = values.config !== undefined;
  if (positionals.length || (application ? (!values.config || !values.name || values.runtime !== undefined) :
    (!values.runtime || values.name !== undefined || values.online !== undefined))) {
    throw new Error(`Usage: fogd doctor ${host ? '--runtime FAMILY | ' : ''}--config FILE --name APP [--online] [--json]`);
  }
  return values;
}
