import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const children = new Set();
export function abortNativeReads() { for (const child of children) child.kill('SIGKILL'); }

export async function boundedJson(body, limit = 4 * 1024 * 1024) {
  const parts = []; let size = 0;
  for await (const part of body) {
    const bytes = Buffer.from(part); size += bytes.length;
    if (size > limit) { body.destroy?.(); throw new Error('Observer JSON exceeds limit'); }
    parts.push(bytes);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export async function nativeJson(host, path) {
  const response = await fetch(`http://${host}:8081${path}`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Native read refused'); }
  return boundedJson(response.body, 256 * 1024);
}
export async function cliRead(env, prefix, args, rows = false) {
  let child, stdout;
  try {
    const pending = promisify(execFile)('/usr/local/bin/celld', args, { env: { ...env, CELLD_BUCKET: `s3://${env.FOGD_BUCKET}/${prefix}` }, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
    child = pending.child; children.add(child); ({ stdout } = await pending);
  } catch (error) { return { error: { code: String(error.code || 'READ_UNAVAILABLE'), signal: error.signal || null, killed: !!error.killed } }; } finally { if (child) children.delete(child); }
  const value = rows ? stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(stdout.trim());
  return { value };
}
