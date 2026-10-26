// Both observers run on one engine clock. Map their request intervals onto that
// clock; per-process monotonic timestamps cannot be compared directly.
export function writeOverlap(reports) {
  if (!Array.isArray(reports) || reports.length !== 2) throw new Error('Expected two concurrent write reports');
  const intervals = reports.map(report => {
    const origin = Date.parse(report.startedAt) - report.startedMs;
    if (!Number.isFinite(origin) || !report.samples?.length) throw new Error('Missing concurrent write timing');
    const starts = report.samples.map(sample => origin + sample.startedMs), ends = report.samples.map(sample => origin + sample.finishedMs);
    if (![...starts, ...ends].every(Number.isFinite) || report.samples.some(sample => sample.finishedMs < sample.startedMs)) throw new Error('Invalid concurrent write timing');
    return { start: Math.min(...starts), end: Math.max(...ends), ids: new Set(report.samples.map(sample => sample.writeId)) };
  });
  const overlapMs = Math.min(...intervals.map(value => value.end)) - Math.max(...intervals.map(value => value.start));
  if (overlapMs <= 0) throw new Error('Application write windows do not overlap');
  return { overlapMs, sharedOperationIds: [...intervals[0].ids].filter(id => intervals[1].ids.has(id)).length };
}
