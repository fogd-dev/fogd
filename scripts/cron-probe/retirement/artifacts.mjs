import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { faultProject } from '../faults/build.mjs';
import { offlineFixture } from '../release/offline.mjs';
import { artifactDigest } from '../../../packages/runtime/src/artifact.mjs';

export async function prepareRetirement(output, mode) {
  const { project } = await faultProject(join(output, 'build'));
  const offline = await offlineFixture(project, join(output, 'offline'));
  const runner = join(output, 'runner'); await mkdir(runner);
  const artifacts = {};
  for (const [name, directory] of [['refresh', 'artifact'], ['scheduled-next', 'next-artifact']]) {
    const target = join(runner, directory); await cp(offline.output, target, { recursive: true });
    const config = JSON.parse(await readFile(join(target, 'wrangler.json'), 'utf8'));
    assert.equal(config.name, 'refresh'); config.name = name;
    await writeFile(join(target, 'wrangler.json'), JSON.stringify(config));
    artifacts[name] = await artifactDigest(target);
  }
  assert.equal(artifacts.refresh, offline.verification.artifactDigest);
  const ids = Object.fromEntries((mode === 'full' ? ['a', 'b', 'c', 'd'] : ['a', 'dual']).map(name => [name, randomUUID()]));
  return { runner, artifact: artifacts.refresh, artifacts, offline: offline.verification,
    ids, policy: { retirementArtifacts: artifacts } };
}
