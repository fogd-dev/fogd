import assert from 'node:assert/strict';
import { docker, projectName } from '../../../packages/cli/src/recovery/docker.mjs';

const groups = [['workerd'], ['controller'], ['slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b', 'slot-3-a', 'slot-3-b'], ['minio', 'bucket-init']];

export async function stopRetainedContainers(project, containers, run = docker) {
  projectName(project);
  const seen = new Set(), services = new Set();
  for (const container of containers) {
    const labels = container.Config.Labels, service = labels['com.docker.compose.service'];
    assert.equal(labels['com.docker.compose.project'], project);
    assert.match(container.Id, /^[a-f0-9]{64}$/);
    assert.ok(groups.flat().includes(service) && !seen.has(container.Id) && !services.has(service));
    seen.add(container.Id); services.add(service);
  }
  // A failed or uncertain group prevents stopping its dependencies.
  for (const group of groups) {
    const ids = containers.filter(container => group.includes(container.Config.Labels['com.docker.compose.service'])).map(container => container.Id);
    if (ids.length) await run(['stop', ...ids]);
  }
}
