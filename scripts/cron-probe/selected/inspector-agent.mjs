// Runs through docker exec stdin; it never writes into the runtime image.
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const methods = new Set(['Debugger.enable', 'Debugger.disable',
  'Debugger.getScriptSource', 'Debugger.getPossibleBreakpoints', 'Debugger.setBreakpoint',
  'Debugger.removeBreakpoint', 'Debugger.resume']);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const targets = await inspectorTargets();
if (targets.length !== 1 || !/^ws:\/\/127\.0\.0\.1:9229\//.test(targets[0].webSocketDebuggerUrl || '')) throw new Error('Expected one loopback inspector target');
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
socket.addEventListener('message', event => {
  if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) { socket.close(); return; }
  emit({ type: 'message', value: JSON.parse(event.data) });
});
socket.addEventListener('close', () => process.exit(0));
socket.addEventListener('error', () => process.exit(1));
const stat = await readFile('/proc/1/stat', 'utf8');
emit({ type: 'ready', processStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] });
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.length > 65536) throw new Error('Debugger command exceeded its limit');
  const request = JSON.parse(line);
  if (!Number.isSafeInteger(request.id) || !methods.has(request.method)) throw new Error('Unsupported debugger command');
  if (request.method === 'Debugger.setBreakpoint' && !['', 'verb === "resume" && releaseHold === true'].includes(request.params?.condition || '')) throw new Error('Unsupported debugger condition');
  socket.send(JSON.stringify(request));
}
socket.close();

async function inspectorTargets() {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    try {
      const response = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
    } catch { /* The signal handler may still be opening the listener. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Controller inspector did not open');
}
