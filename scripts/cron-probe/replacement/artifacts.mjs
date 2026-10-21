import assert from 'node:assert/strict';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { replacementProject } from './build.mjs';
import { offlineReplacement } from './offline.mjs';
import { replacementPlan } from './policy.mjs';
import { artifactDigest } from '../../../packages/runtime/src/artifact.mjs';

export async function prepareReplacement(output) {
  const runner = join(output, 'runner'); await mkdir(join(runner, 'artifacts'), { recursive: true });
  const releases = {}, artifacts = {};
  for (const name of ['old', 'new', 'final']) {
    await replacementProject(join(output, name), name);
    releases[name] = await offlineReplacement(join(output, name, 'project'), join(output, `${name}-offline`));
    assert.deepEqual(releases.old.config.d1_databases, releases[name].config.d1_databases);
    await cp(releases[name].output, join(runner, 'artifacts', name), { recursive: true });
    artifacts[name] = await artifactDigest(join(runner, 'artifacts', name));
    assert.equal(artifacts[name], releases[name].verification.artifactDigest, 'Deployed artifact must equal the actual offline build output');
  }
  assert.equal(new Set(Object.values(artifacts)).size, 3, 'Replacement digests must identify distinct releases');
  return { runner, releases, policy: { replacement: replacementPlan(artifacts) } };
}
