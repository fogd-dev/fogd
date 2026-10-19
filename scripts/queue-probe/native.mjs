import { buildEnvironment } from '../../packages/cli/src/build-env.mjs';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { run, stackRoot } from '../../packages/cli/src/local.mjs';
import { translateConfig } from '../../packages/runtime/src/artifact.mjs';

// Direct celld qualification only. This does not create an admissible fogd artifact.
export async function stageNative(directory, project = join(stackRoot, 'examples/imports')) {
  const output = resolve(directory);
  await mkdir(output, { mode: 0o700 });
  await run(process.execPath, [join(stackRoot, 'packages/cli/src/build.mjs'), project], { cwd: project, env: buildEnvironment() });
  const source = JSON.parse(await readFile(join(project, 'dist/ssr/wrangler.json'), 'utf8'));
  const config = translateConfig({ ...source, queues: undefined }, 'imports');
  assert.deepEqual(source.queues.producers, [{ binding: 'QUEUE_IMPORTS', queue: 'imports' }]);
  assert.deepEqual(source.queues.consumers, [{ queue: 'imports', max_batch_size: 1, max_batch_timeout: 1, max_retries: 1, retry_delay: 1 }]);
  config.queues = source.queues;
  await cp(join(project, 'dist/ssr'), join(output, 'worker'), { recursive: true });
  await mkdir(join(output, 'migrations'), { mode: 0o700 });
  await cp(join(project, 'db/migrations'), join(output, 'migrations/DB'), { recursive: true });
  await writeFile(join(output, 'wrangler.json'), JSON.stringify(config, null, 2));
  const bootstrap = join(output, 'bootstrap'); await mkdir(bootstrap);
  const bootstrapConfig = { name: config.name, main: 'index.js', no_bundle: true, compatibility_date: config.compatibility_date, d1_databases: config.d1_databases, queues: { producers: config.queues.producers } };
  await writeFile(join(bootstrap, 'wrangler.json'), JSON.stringify(bootstrapConfig));
  await writeFile(join(bootstrap, 'index.js'), "export default {fetch(){return new Response('Bootstrap',{status:503})}};\n");
  return { output, config, bootstrap };
}
