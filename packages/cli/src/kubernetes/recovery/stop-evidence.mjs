import { spawn } from 'node:child_process';

const format = String.raw`{{.type}}|{{.object.metadata.name}}|{{.object.metadata.uid}}|{{if .object.metadata.deletionTimestamp}}terminating{{else}}running{{end}}|{{range .object.status.containerStatuses}}{{.name}}:{{if .state.terminated}}{{.state.terminated.exitCode}}:{{.state.terminated.reason}}{{else}}unknown{{end}};{{end}}{{"\n"}}`;
export function recordStopLine(line, expected, records) {
  const [event, name, uid, phase, statuses] = line.split('|');
  if (expected.get(name) !== uid) return;
  const containers = (statuses || '').split(';').filter(Boolean).map(value => {
    const [name, code, reason] = value.split(':');
    return phase !== 'terminating' || code === 'unknown' ? { name, outcome: 'unknown' } : { name, outcome: 'observed', exitCode: Number(code), reason };
  });
  const previous = records.get(name);
  const observed = event === 'DELETED' && previous?.phase === 'terminating' && !containers.some(c => c.outcome === 'observed') ? previous.containers : containers;
  records.set(name, { name, uid, event, phase, containers: observed, at: new Date().toISOString() });
}
export async function observeStops(conn, namespace, pods) {
  const expected = new Map(pods.map(p => [p.metadata.name, p.metadata.uid])), records = new Map();
  const child = spawn('kubectl', [...conn.base, '-n', namespace, 'get', 'pods', '--watch', '--output-watch-events', '-o', `go-template=${format}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffered = '', error;
  child.stderr.resume(); child.on('error', value => { error = value; });
  child.stdout.on('data', data => {
    buffered += data;
    const lines = buffered.split('\n'); buffered = lines.pop();
    for (const line of lines) recordStopLine(line, expected, records);
  });
  const closed = new Promise(resolve => child.on('close', resolve));
  async function finish() {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await closed; } finally { clearTimeout(timer); }
    return pods.map(p => records.get(p.metadata.name) || { name: p.metadata.name, uid: p.metadata.uid, event: 'unobserved', containers: [] });
  }
  const deadline = Date.now() + 15000;
  while (records.size !== expected.size) {
    if (error || child.exitCode !== null || Date.now() >= deadline) { await finish(); throw new Error('Cannot establish pod termination observation before stopping writers'); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { finish };
}
export function uncertainStops(records) {
  return records.filter(p => p.name !== 'workerd-0' && (!p.containers.length || p.containers.some(c => c.outcome !== 'observed' || c.exitCode !== 0 || c.reason !== 'Completed'))).map(p => p.name);
}
