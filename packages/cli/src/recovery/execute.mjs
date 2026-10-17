import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

// Keep configuration and credentials out of command diagnostics.
export async function execute(command, args, { env = process.env, output, input, inputText, timeoutMs = 900000 } = {}) {
  let out, source;
  try {
    out = output ? await open(output, 'wx', 0o600) : null;
    source = input ? await open(input, 'r') : null;
    return await capture(command, args, { env, out, source, inputText, timeoutMs });
  } finally { await out?.sync(); await out?.close(); await source?.close(); }
}
function capture(command, args, { env, out, source, inputText, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let stdout = '', failure, force;
    const child = spawn(command, args, { env, stdio: [source?.fd ?? (inputText === undefined ? 'ignore' : 'pipe'), out?.fd ?? 'pipe', 'pipe'] });
    function abort(message) {
      failure ||= new Error(message); child.kill('SIGTERM');
      force ||= setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }
    const deadline = setTimeout(() => abort(`${command} command timed out; inspect installation state locally`), timeoutMs).unref();
    if (inputText !== undefined) {
      child.stdin.on('error', () => abort(`${command} input stream failed`)); child.stdin.end(inputText);
    }
    child.stdout?.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) abort(`${command} diagnostic output exceeded its limit`);
    });
    child.stderr.resume();
    child.on('error', () => { failure = new Error(`${command} could not start`); });
    child.on('close', code => {
      clearTimeout(deadline); clearTimeout(force);
      if (!failure && code === 0) resolve(stdout);
      else { const error = failure || new Error(`${command} command failed (${code}); inspect installation state locally`); error.exitCode = code; reject(error); }
    });
  });
}
