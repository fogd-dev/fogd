import { parseArgs } from 'node:util';
import { runtimeFamily } from '../../packages/cli/src/runtime/catalog.mjs';

export function writeServingOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    runtime: { type: 'string' }, candidate: { type: 'boolean', default: false }, 'retain-resources': { type: 'boolean', default: false },
  } });
  if (positionals.length !== 1 || !positionals[0]) throw new Error('Expected one new private output directory');
  if (values.candidate && !values.runtime) throw new Error('Candidate qualification requires an explicit runtime family');
  const runtime = values.runtime ?? 'celld-cron-v2-linux-arm64';
  runtimeFamily(runtime, values.candidate ? 'candidate' : 'new');
  return { output: positionals[0], enrollment: values.candidate ? 'candidate' : 'public',
    hostOptions: { runtime, retainResources: values['retain-resources'] } };
}
