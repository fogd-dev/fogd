import { spawn } from 'node:child_process';

import { previewDeadline } from './deadline.mjs';

const terminationGraceMs = 1000;
const observationGraceMs = 1000;

const result = (outcome, started, childExitConfirmed, exitCode = null, signal = null) => ({ outcome, started, childExitConfirmed, exitCode, signal });

// Internal launcher primitive. The caller must independently authorize the exact
// preview and supply its fixed service command, environment and isolated storage.
// This function controls only its own child. It grants no execution permission.
export async function supervisePreviewProcess({ executable, args = [], env = {}, cwd, expiresAt, signal }) {
  const expires = previewDeadline(expiresAt);
  if (typeof executable !== 'string' || !executable || !Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('Preview service requires a fixed executable and string arguments');
  const environment = previewEnvironment(env);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Preview cancellation requires an AbortSignal');
  if (expires <= Date.now()) return result('expired', false, true);
  if (signal?.aborted) return result('cancelled', false, true);
  return supervise({ executable, args, env: environment, cwd, expires, signal });
}

function previewEnvironment(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Preview environment must be supplied explicitly as string values');
  const environment = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') throw new Error('Preview environment must be supplied explicitly as string values');
    environment[key] = value;
  }
  return environment;
}

function supervise({ executable, args, env, cwd, expires, signal }) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { env, cwd, shell: false, stdio: ['ignore', 'inherit', 'inherit'] });
    let outcome = 'exited', finished = false, hardStop, observation;
    const finish = (code, exitSignal, confirmed) => {
      if (finished) return;
      finished = true;
      for (const timer of [expiry, clockCheck, hardStop, observation]) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(result(outcome, Boolean(child.pid), confirmed, code, exitSignal));
    };
    const terminate = name => {
      try { child.kill(name); } catch {}
    };
    const stop = reason => {
      if (finished || outcome !== 'exited') return;
      outcome = reason;
      terminate('SIGTERM');
      hardStop = setTimeout(() => terminate('SIGKILL'), terminationGraceMs);
      observation = setTimeout(() => { outcome = 'stop-unconfirmed'; finish(null, null, false); }, terminationGraceMs + observationGraceMs);
    };
    const cancel = () => stop('cancelled');
    // The initial timer cannot be extended by a wall-clock rollback in this
    // process. A forward clock change is checked independently. Restart uses the
    // same absolute expiry; the host clock remains a trusted prerequisite.
    const expiry = setTimeout(() => stop('expired'), Math.max(0, expires - Date.now()));
    const clockCheck = setInterval(() => { if (Date.now() >= expires) stop('expired'); }, 100);
    child.once('exit', (code, exitSignal) => finish(code, exitSignal, true));
    child.on('error', () => {
      if (finished) return;
      if (!child.pid) { outcome = 'start-failed'; finish(null, null, true); }
      else stop('control-failed');
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
