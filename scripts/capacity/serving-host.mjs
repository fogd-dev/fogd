import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpus, loadavg, totalmem, freemem, platform, arch } from 'node:os';
import { composeArgs, json, docker } from '../../packages/cli/src/recovery/docker.mjs';
import { servingSession, markServing } from './serving-session.mjs';
import { servingReport, interferenceRequests } from './serving-observer.mjs';

export async function observeWindow(host, observer, name, settings, action) {
  const session = await servingSession(host, observer, name, settings);
  let interference = null, started = false;
  try {
    await session.ready;
    if (action) {
      const start = await markServing(host, observer, 'start'); started = true;
      const outcome = await action(), end = await markServing(host, observer, 'end');
      interference = { start, end, outcome };
    }
    const report = await session.done; assert.equal(report.truncated, false); assert.deepEqual(report.summaries, servingReport(report.samples));
    for (const sample of report.samples) assert.ok(sample.startedMs >= report.startedMs && sample.finishedMs <= report.finishedMs);
    if (interference) {
      assert.equal(interference.start.time, report.markers.start); assert.equal(interference.end.time, report.markers.end);
      report.interference = { ...interference, overlappingRequests: interferenceRequests(report) };
    }
    return report;
  } catch (error) {
    if (started && !interference) await markServing(host, observer, 'end').catch(() => {});
    await session.done.catch(() => {}); throw error;
  }
}

export async function startObserver(host, name, fleet) {
  const control = host.config.networks.control.name, node = host.config.services[fleet.nodes[0].host];
  const [key] = Object.keys(node.networks); const network = host.config.networks[key]?.name;
  assert.ok(network);
  await host.run('docker', ['run', '-d', '--pull', 'never', '--name', name, '--label', `fogd.qualifier.project=${host.project}`, '--network', control, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '1', '--entrypoint', '/usr/local/bin/node', host.entry.image, '-e', 'setInterval(()=>{},1000)']);
  await host.run('docker', ['network', 'connect', network, name]);
}
export function ownCompose(host, args) {
  return host.run('docker', [...composeArgs(join(host.env.FOGD_HOME, '.fogd/installations', host.project, 'compose.json'), host.project), ...args]);
}
export async function hardware(host) {
  const info = await json(['info', '--format', '{{json .}}']);
  return { hostNode: process.version, host: { platform: platform(), architecture: arch(), cpus: cpus().length, totalMemoryBytes: totalmem(), availableMemoryBytes: freemem(), loadAverage: loadavg() }, engine: { version: info.ServerVersion, os: info.OSType, architecture: info.Architecture, cpus: info.NCPU, memoryBytes: info.MemTotal, driver: info.Driver }, observer: { memoryBytes: 128 * 1024 ** 2, cpuLimit: 1 }, unrelatedContainers: (await docker(['ps', '-q'])).trim().split('\n').filter(Boolean).length - (await docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${host.project}`])).trim().split('\n').filter(Boolean).length };
}
export async function serviceMetrics(host, service) {
  const [id] = (await docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${host.project}`, '--filter', `label=com.docker.compose.service=${service}`])).trim().split('\n'); assert.ok(id);
  const [container] = await json(['inspect', id]);
  const lines = (await host.run('docker', ['exec', id, 'cat', '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/cpu.stat'])).trim().split('\n');
  assert.match(lines[0], /^\d+$/); assert.match(lines[1], /^\d+$/);
  return { startedAt: container.State.StartedAt, memoryLimitBytes: container.HostConfig.Memory, nanoCPUs: container.HostConfig.NanoCpus,
    counters: { 'memory.current': lines[0], 'memory.peak': lines[1], 'cpu.stat': lines.slice(2).join('\n') } };
}

export async function stackMetrics(host) {
  const metrics = {};
  for (const service of Object.keys(host.config.services).filter(name => name !== 'bucket-init')) metrics[service] = await serviceMetrics(host, service);
  return metrics;
}
