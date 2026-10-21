import assert from 'node:assert/strict';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { offlineFixture } from './offline.mjs';
import { releasePlan } from './policy.mjs';
import { artifactDigest } from '../../../packages/runtime/src/artifact.mjs';

export async function prepareReleaseArtifacts(output, contract, schedules, createProject) {
  const runner = join(output, 'runner'); await mkdir(join(runner, 'artifacts'), { recursive: true });
  const releases = {}, artifacts = {}; let declarations;
  for (const [name, cron] of Object.entries(schedules)) {
    await createProject(join(output, name), name, cron);
    releases[name] = await offlineFixture(join(output, name, 'project'), join(output, `${name}-offline`), cron);
    declarations ||= releases[name].config.d1_databases;
    assert.deepEqual(declarations, releases[name].config.d1_databases);
    await cp(releases[name].output, join(runner, 'artifacts', name), { recursive: true });
    artifacts[name] = await artifactDigest(join(runner, 'artifacts', name));
    assert.equal(artifacts[name], releases[name].verification.artifactDigest, 'Deployed artifact must equal the actual offline build output');
  }
  return { runner, releases, policy: { releases: releasePlan(contract, artifacts) } };
}
