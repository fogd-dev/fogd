import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function servingSession(host, observer, phase, settings) {
  const code = await readFile(new URL('./serving-observer.mjs', import.meta.url), 'utf8');
  const child = spawn('docker', ['exec', '-i', observer, 'node', '--input-type=module', '-', JSON.stringify(settings)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), settings.maxDurationMs + 20000);
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > 16 * 1024 ** 2) child.kill('SIGTERM');
    const first = stdout.indexOf('\n');
    if (first >= 0) {
      try { const value = JSON.parse(stdout.slice(0, first)); if (value.ready === true) readyResolve(value); }
      catch { child.kill('SIGTERM'); }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 1024 ** 2) child.kill('SIGTERM'); });
  const done = new Promise((resolve, reject) => {
    child.once('error', error => { clearTimeout(timeout); readyReject(error); reject(error); });
    child.once('close', async (exitCode, signal) => {
      clearTimeout(timeout);
      try {
        await writeFile(join(host.output, `observer-${phase}.json`), JSON.stringify({ exitCode, signal, stdout, stderr }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        if (exitCode !== 0 || signal) throw new Error('Serving observer did not complete; inspect its private diagnostic');
        const lines = stdout.trim().split('\n');
        if (lines.length !== 2 || JSON.parse(lines[0]).ready !== true) throw new Error('Serving observer returned incomplete evidence');
        resolve(JSON.parse(lines[1]));
      } catch (error) { readyReject(error); reject(error); }
    });
  });
  done.catch(() => {});
  child.stdin.on('error', () => {}); child.stdin.end(code);
  ready.catch(() => {});
  return { ready, done };
}

export async function markServing(host, observer, marker) {
  if (!['start', 'end'].includes(marker)) throw new Error('Unknown serving marker');
  const code = `const response=await fetch('http://127.0.0.1:9080/${marker}',{method:'POST',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('Serving marker refused');console.log(await response.text());`;
  return JSON.parse(await host.run('docker', ['exec', observer, 'node', '--input-type=module', '-e', code]));
}
