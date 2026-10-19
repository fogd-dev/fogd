import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { devNull } from 'node:os';
import { json } from '../recovery/docker.mjs';
import { stackRoot } from '../local.mjs';
import { fleetCount, extendTemplate } from './template.mjs';

export async function dockerCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { fleets: { type: 'string', default: '2' } } });
  const [action, directory] = positionals;
  if (action !== 'render' || !directory || positionals.length !== 2) throw new Error('Usage: fogd docker render DIRECTORY --fleets 2|3');
  const count = fleetCount(values.fleets), output = resolve(directory);
  const base = await json(['compose', '--env-file', devNull, '-f', join(stackRoot, 'compose.yaml'), 'config', '--no-interpolate', '--format', 'json']);
  const template = extendTemplate(base, count);
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, 'compose.json'), JSON.stringify(template, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Wrote ${count}-fleet Compose template: ${join(output, 'compose.json')}\nSet COMPOSE_PROJECT_NAME explicitly and FOGD_COMPOSE_FILE to this path for TLS import, fogd up, and backup. Environment variables resolve at execution time.\nDefault ceilings: ${1536 + count * 1024} MiB memory and ${4 + count * 2} CPU cores (ceilings, not reservations; FOGD_CELLD_* and FOGD_MINIO_* can override them).`);
}
