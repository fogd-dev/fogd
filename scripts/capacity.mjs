import { open } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { docker, projectContainers, projectName, json } from '../packages/cli/src/recovery/docker.mjs';
import { inventory, unchanged, sample, summary } from './capacity/metrics.mjs';

const { values } = parseArgs({ options: { project: { type: 'string' }, output: { type: 'string' }, samples: { type: 'string', default: '12' }, interval: { type: 'string', default: '5000' } } });
const project = projectName(values.project);
const count = Number(values.samples), interval = Number(values.interval);
if (!values.output || !Number.isInteger(count) || count < 3 || count > 360 || !Number.isInteger(interval) || interval < 1000 || interval > 60000) throw new Error('Use --project NAME --output FILE [--samples 3..360 --interval 1000..60000 milliseconds]');
async function inspect() {
  const all = await projectContainers(project);
  if (all.some(c => c.Config.Labels['com.docker.compose.service'] === 'bucket-init' && c.State.Running)) throw new Error('Wait for bucket initialization to finish');
  const containers = all.filter(c => c.Config.Labels['com.docker.compose.service'] !== 'bucket-init');
  return inventory(containers.map(c => ({ id: c.Id, service: c.Config.Labels['com.docker.compose.service'], image: c.Image, startedAt: c.State.StartedAt, running: c.State.Running, paused: c.State.Paused, restarting: c.State.Restarting, restarts: c.RestartCount, memoryLimitBytes: c.HostConfig.Memory, cpuLimit: c.HostConfig.NanoCpus / 1e9 })));
}
const reportFile = await open(values.output, 'wx', 0o600);
try {
  const before = await inspect();
  const engine = await json(['info', '--format', '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}},"version":{{json .ServerVersion}},"operatingSystem":{{json .OperatingSystem}},"cgroupVersion":{{json .CgroupVersion}}}']);
  const running = (await docker(['ps', '-q'])).trim().split(/\s+/).filter(Boolean).length;
  const vmMemory = await docker(['exec', before.find(c => c.service === 'controller').id, 'node', '--input-type=module', '-e', "import {readFileSync} from 'node:fs'; console.log(readFileSync('/proc/meminfo','utf8').split('\\n').filter(line => /^(MemTotal|MemAvailable|SwapTotal|SwapFree):/.test(line)).join('\\n'))"]);
  const samples = [], began = performance.now();
  let previousFinished = Date.now();
  for (let i = 0; i < count; i++) {
    const startedAt = new Date().toISOString(), sampleStart = performance.now();
    if (Date.now() - previousFinished > 2 * (interval + 10000)) throw new Error('Observation gap is too long; repeat without host sleep or a stalled Docker engine');
    const output = await docker(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}', ...before.map(c => c.id)]);
    const rows = output.trim().split('\n').map(line => JSON.parse(line));
    unchanged(before, await inspect());
    if (performance.now() - sampleStart > 20000 || Date.now() - Date.parse(startedAt) > 20000) throw new Error('Docker observation took too long; repeat on an awake, responsive host');
    samples.push({ startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - began, containers: sample(rows, before) });
    previousFinished = Date.now();
    console.error(`Captured ${i + 1}/${count} samples`);
    if (i + 1 < count) await setTimeout(interval);
  }
  const report = { project, engine, vmMemoryAtStart: vmMemory.trim(), unrelatedRunningContainers: running - before.length, requestedIntervalMs: interval, containers: before, samples, summary: summary(samples), caveats: ['Docker CLI memory usage excludes some cache on Linux; this is not RSS or peak allocation.', 'CPU percentages are sampled and can exceed 100% across cores.', 'Memory ceilings are not reservations. Shared-host observations are not production sizing.', 'Image/container identities are retained; credentials and full inspection output are excluded.'] };
  await reportFile.writeFile(`${JSON.stringify(report, null, 2)}\n`);
  await reportFile.sync();
  console.log(JSON.stringify(report.summary, null, 2));
} finally { await reportFile.close(); }
