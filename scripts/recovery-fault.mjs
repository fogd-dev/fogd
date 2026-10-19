import assert from 'node:assert/strict';
import { writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from './guestbook-browser.mjs';
const exec = promisify(execFile);

export async function interruptAfterControllerRestore({ cli, args, env, project, shim }) {
  await mkdir(shim, { mode: 0o700 });
  const marker = join(shim, 'controller-copied'), realDocker = (await exec('which', ['docker'])).stdout.trim();
  await writeFile(join(shim, 'docker'), `#!/usr/bin/env python3
import os,sys,subprocess,time,pathlib
args=sys.argv[1:]
match=args[:1]==['run'] and any(${JSON.stringify(`src=${project}_controller,`)} in a for a in args) and 'tar --numeric-owner -C /data -xpf - && sync -f /data' in args
if not match: os.execv(${JSON.stringify(realDocker)},[${JSON.stringify(realDocker)},*args])
result=subprocess.run([${JSON.stringify(realDocker)},*args])
if result.returncode: sys.exit(result.returncode)
pathlib.Path(${JSON.stringify(marker)}).write_text('copied')
while True: time.sleep(1)
`, { mode: 0o700 });
  const child = spawn(process.execPath, [cli, ...args], { env: { ...env, PATH: `${shim}:${env.PATH}` }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '', ended = false;
  child.stdout.on('data', data => { diagnostics = (diagnostics + data).slice(-4000); });
  child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-4000); });
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => { ended = true; resolve(code); }); });
  try {
    await expect.poll(async () => { if (ended) throw new Error(`Restore exited before injection: ${diagnostics}`); try { await access(marker); return true; } catch { return false; } }, { timeout: 180000 }).toBe(true);
  } finally { if (!ended) process.kill(-child.pid, 'SIGTERM'); }
  assert.notEqual(await closed, 0);
}
