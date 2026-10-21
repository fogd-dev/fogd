import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stageRefresh } from '../native.mjs';
import { artifactDigest } from '../../../packages/runtime/src/artifact.mjs';
import { interruptionPlan } from './policy.mjs';

export async function prepareActivation(output) {
  const stage = await stageRefresh(join(output, 'build'));
  await writeFile(join(stage.output, 'wrangler.json'), JSON.stringify(stage.config));
  const runner = join(output, 'runner'); await mkdir(join(runner, 'artifacts'), { recursive: true });
  const artifacts = {};
  for (const name of ['first-publication', 'update-durable-release', 'paused-update-publication']) {
    const path = join(runner, 'artifacts', name); await cp(stage.output, path, { recursive: true });
    const config = structuredClone(stage.config);
    config.vars = { ...config.vars, FOGD_INTERRUPTION_CASE: name };
    await writeFile(join(path, 'wrangler.json'), JSON.stringify(config));
    artifacts[name] = await artifactDigest(path);
  }
  return { runner, stage, policy: { interruption: interruptionPlan(artifacts) } };
}
