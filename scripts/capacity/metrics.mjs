export function bytes(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)$/.exec(value.trim());
  if (!match) throw new Error('Unreadable Docker memory statistic');
  const units = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
  return Number(match[1]) * units[match[2]];
}
export function inventory(containers) {
  const names = containers.map(c => c.service);
  const fleets = [...new Set(names.filter(n => /^slot-[1-9]\d*-[ab]$/.test(n)).map(n => n.slice(0, -2)))].sort();
  const expected = ['controller', 'minio', 'workerd', ...fleets.flatMap(f => [`${f}-a`, `${f}-b`])].sort();
  if (!fleets.length || JSON.stringify([...names].sort()) !== JSON.stringify(expected)) throw new Error('Expected shared services and complete, unique two-replica fleets');
  if (containers.some(c => !c.running || c.paused || c.restarting)) throw new Error('Every measured container must be running normally');
  return containers.map(c => ({ ...c, group: c.service.startsWith('slot-') ? c.service.slice(0, -2) : 'shared' }));
}
export function unchanged(before, after) {
  const identity = list => list.map(c => [c.id, c.startedAt, c.restarts, c.service]).sort((a, b) => a[0].localeCompare(b[0]));
  if (JSON.stringify(identity(before)) !== JSON.stringify(identity(after))) throw new Error('Container inventory or restart state changed during measurement');
}
export function sample(rows, containers) {
  if (rows.length !== containers.length) throw new Error('Incomplete Docker statistics');
  const ids = new Set();
  return rows.map(row => {
    if (typeof row.ID !== 'string' || !row.ID) throw new Error('Missing Docker container identity');
    const container = containers.find(c => c.id === row.ID);
    if (!container || !row.ID || ids.has(container.id)) throw new Error('Unknown or duplicate Docker statistics');
    ids.add(container.id);
    if (!/^\d+(?:\.\d+)?%$/.test(row.CPUPerc)) throw new Error('Unreadable Docker CPU statistic');
    const memory = row.MemUsage.split(' / ');
    if (memory.length !== 2) throw new Error('Unreadable Docker memory usage');
    return { service: container.service, group: container.group, memoryBytes: bytes(memory[0]), cpuPercent: Number(row.CPUPerc.slice(0, -1)) };
  });
}
export function summary(samples) {
  const groups = [...new Set(samples[0].containers.map(c => c.group)), 'total'];
  return Object.fromEntries(groups.map(group => {
    const values = samples.map(s => s.containers.filter(c => group === 'total' || c.group === group));
    const sums = key => values.map(cs => cs.reduce((sum, c) => sum + c[key], 0));
    const memory = sums('memoryBytes'), cpu = sums('cpuPercent');
    return [group, { memoryMinBytes: Math.min(...memory), memoryMaxBytes: Math.max(...memory), cpuMeanPercent: cpu.reduce((a, b) => a + b, 0) / cpu.length, cpuMaxPercent: Math.max(...cpu) }];
  }));
}
