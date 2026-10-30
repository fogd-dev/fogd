import { parseArgs } from 'node:util';
import { uuid } from '../build-cache/paths.mjs';
import { exportArtifactReview } from './export.mjs';

export async function reviewCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { output: { type: 'string' } } });
  if (positionals.length !== 1 || !uuid(positionals[0]) || !values.output) throw new Error('Usage: fogd admin review ID --output NEW_PRIVATE_DIRECTORY');
  const { directory, report } = await exportArtifactReview(positionals[0], values.output);
  console.log(JSON.stringify({ directory, ...report }, null, 2));
}
