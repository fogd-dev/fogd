import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

export function startReader(args, log) {
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let failure;
  const terminal = new Promise(resolve => {
    child.on('error', error => { failure = error; });
    child.on('close', (code, signal) => resolve({ code, signal, failure: failure?.message }));
  });
  child.stdin.on('error', error => { failure = error; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const errors = createWriteStream(log + '.stderr', { flags: 'wx', mode: 0o600 });
  errors.on('error', error => { failure = error; }); child.stderr.pipe(errors);
  async function bounded(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Reader phase timed out')), 20000); })]); }
    finally { clearTimeout(timer); }
  }
  async function readUntil(prefix) {
    while (true) {
      const row = await lines.next();
      if (row.done) throw new Error('Reader ended before its expected result');
      await appendFile(log, row.value + '\n', { mode: 0o600 });
      if (row.value.startsWith(prefix)) return row.value.slice(prefix.length);
    }
  }
  return { executable: async () => JSON.parse(await bounded(readUntil('ROUTE_EXECUTABLE '))), nextPhase: () => bounded(readUntil('ROUTE_PHASE ')), result: async () => JSON.parse(await bounded(readUntil('ROUTE_RESULT '))),
    advance: phase => new Promise((resolve, reject) => child.stdin.write(phase + '\n', error => error ? reject(error) : resolve())),
    async finish() {
      await bounded((async () => { for await (const row of lines) await appendFile(log, row + '\n', { mode: 0o600 }); })());
      const result = await bounded(terminal); await bounded(finished(errors)); return { ...result, failure: failure?.message }; },
    endInput() { child.stdin.end(); }, kill() { child.kill('SIGTERM'); } };
}
