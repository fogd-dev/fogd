import { devNull } from 'node:os';
import { resolve, join } from 'node:path';
import { stackRoot } from '../local.mjs';
import { json } from '../recovery/docker.mjs';
import { composeResolved } from '../recovery/bundle.mjs';
export async function resolvedCompose(env) {
  const file = resolve(env.FOGD_COMPOSE_FILE || join(stackRoot, 'compose.yaml'));
  return composeResolved(await json(['compose', '--env-file', devNull, '--project-directory', stackRoot, '-f', file, 'config', '--format', 'json'], { env }));
}
