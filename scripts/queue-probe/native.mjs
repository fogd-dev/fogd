import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stackRoot } from '../../packages/cli/src/local.mjs';
import { translateConfig } from '../../packages/runtime/src/artifact.mjs';
import { nativeBuild } from '../native-build.mjs';

// Direct celld qualification only. This does not create an admissible fogd artifact.
export async function stageNative(directory, project = join(stackRoot, 'examples/imports')) {
  const { output, config } = await nativeBuild(directory, project, source => {
    assert.deepEqual(source.queues.producers, [{ binding: 'QUEUE_IMPORTS', queue: 'imports' }]);
    assert.deepEqual(source.queues.consumers, [{ queue: 'imports', max_batch_size: 1, max_batch_timeout: 1, max_retries: 1, retry_delay: 1 }]);
    return { ...translateConfig({ ...source, queues: undefined }, 'imports'), queues: source.queues };
  });
  const bootstrap = join(output, 'bootstrap'); await mkdir(bootstrap);
  const bootstrapConfig = { name: config.name, main: 'index.js', no_bundle: true, compatibility_date: config.compatibility_date, d1_databases: config.d1_databases, queues: { producers: config.queues.producers } };
  await writeFile(join(bootstrap, 'wrangler.json'), JSON.stringify(bootstrapConfig));
  await writeFile(join(bootstrap, 'index.js'), "export default {fetch(){return new Response('Bootstrap',{status:503})}};\n");
  return { output, config, bootstrap };
}
