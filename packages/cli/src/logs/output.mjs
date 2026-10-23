import { mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname, basename, join, sep } from 'node:path';
import { stackRoot } from '../local.mjs';

export async function privateLogOutput(input) {
  const requested = resolve(input), parent = await realpath(dirname(requested));
  const output = join(parent, basename(requested)), installations = await realpath(join(stackRoot, '.fogd/installations'));
  if (output === installations || output.startsWith(installations + sep)) throw new Error('Log output must be outside installation records');
  try { await mkdir(output, { mode: 0o700 }); }
  catch { throw new Error('Log output requires a new directory under an existing private parent'); }
  return output;
}
