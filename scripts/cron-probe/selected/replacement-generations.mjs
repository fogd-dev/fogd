import assert from 'node:assert/strict';

export async function generationLogReader(host, slotId) {
  const fleet = host.policy.fleets.find(value => value.id === slotId); assert.ok(fleet);
  const nodes = [];
  for (const node of fleet.nodes) {
    const [container] = JSON.parse(await host.run('docker', ['inspect', `${host.project}-${node.host}-1`]));
    assert.equal(container.Image, host.entry.image); assert.equal(container.State.Running, true);
    assert.equal(container.Config.Labels['com.docker.compose.project'], host.project); assert.equal(container.Config.Labels['com.docker.compose.service'], node.host);
    nodes.push({ ...node, container: container.Id });
  }
  return async (nodeId, since) => {
    const node = nodes.find(value => value.id === nodeId); assert.ok(node);
    assert.ok(Number.isSafeInteger(since) && since > 0);
    return host.run('docker', ['logs', '--since', new Date(since).toISOString(), node.container]);
  };
}
export function generationEvent(logs, event, generation, version) {
  assert.ok(['deployment_generation_adopted', 'deployment_generation_freed', 'generation_swap_out'].includes(event));
  assert.ok(Number.isSafeInteger(generation) && generation >= 0); assert.match(version, /^[a-f0-9]{16,64}$/);
  const matches = logs.split('\n').filter(line => line.includes(`event="${event}"`) && new RegExp(`\\bgeneration=${generation}(?:\\s|$)`).test(line) &&
    (event === 'generation_swap_out' ? line.includes('scope=.cron:refresh ') : new RegExp(`\\bversion=${version}(?:\\s|$)`).test(line)));
  assert.ok(matches.length <= 1, 'Ambiguous native generation event');
  if (!matches.length) return null;
  const at = Date.parse(matches[0].split(' ')[0]); assert.ok(Number.isSafeInteger(at)); return { at, line: matches[0] };
}
