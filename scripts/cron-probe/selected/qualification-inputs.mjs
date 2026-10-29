import { parseArgs } from 'node:util';

export function qualificationInputs(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    runtime: { type: 'string', default: 'celld-cron-v2-linux-arm64' },
    'retain-resources': { type: 'boolean', default: false },
  } });
  if (positionals.length !== 1) throw new Error('Provide one new private output directory, an optional --runtime family and --retain-resources');
  return { output: positionals[0], hostOptions: { runtime: values.runtime, retainResources: values['retain-resources'] } };
}
