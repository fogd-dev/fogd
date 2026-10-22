import assert from 'node:assert/strict';
import { join } from 'node:path';
import { replacementProject } from '../replacement/build.mjs';
import { offlineFixtureSet } from './offline-fixtures.mjs';

export async function replacementFixtures(host) {
  const projects = {};
  for (const release of ['old', 'new', 'final']) {
    const { project } = await replacementProject(join(host.output, `replacement-${release}-source`), release);
    projects[release] = { project, cron: '* * * * *' };
  }
  const fixture = await offlineFixtureSet(host, projects);
  const builds = Object.values(fixture.builds);
  assert.equal(new Set(builds.map(build => build.verification.release.digest)).size, 3);
  for (const [release, build] of Object.entries(fixture.builds)) {
    assert.deepEqual(build.verification.release.requiredSecrets, ['REFRESH_TOKEN']);
    assert.deepEqual(build.verification.release.migrations.map(migration => migration.name), release === 'old'
      ? ['0001_refresh.sql', '0002_replacement.sql']
      : ['0001_refresh.sql', '0002_replacement.sql', '0003_compatible.sql']);
  }
  return fixture;
}
