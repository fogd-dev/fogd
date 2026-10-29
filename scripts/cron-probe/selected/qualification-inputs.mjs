import { parseArgs } from 'node:util';

export function qualificationInputs(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    runtime: { type: 'string', default: 'celld-cron-v2-linux-arm64' },
    'retain-resources': { type: 'boolean', default: false },
    'sdk-image': { type: 'string' },
  } });
  if (positionals.length !== 1) throw new Error('Provide one new private output directory, optional --runtime and --sdk-image, and --retain-resources');
  if (values['sdk-image'] !== undefined && !/^sha256:[a-f0-9]{64}$/.test(values['sdk-image'])) throw new Error('SDK image must be an immutable local image digest');
  return { output: positionals[0], hostOptions: { runtime: values.runtime, retainResources: values['retain-resources'], sdkImage: values['sdk-image'] } };
}
