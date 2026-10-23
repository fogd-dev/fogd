import { constants } from 'node:fs';
import { open, lstat, chmod, rename, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeAtomicFile } from './atomic-file.mjs';
import { decodeRuntimePolicy, validateRuntimePolicy, runtimePolicyIdentity, RuntimePolicyError, RUNTIME_POLICY_MAX_BYTES } from './runtime-policy.mjs';

export const RUNTIME_POLICY_DIRECTORY = '/var/lib/fogd-runtime';
const filename = 'policy.json';

export function installedRuntimePolicy(env) { return readRuntimePolicy(RUNTIME_POLICY_DIRECTORY, env); }

// An absent policy directory is the legacy path. An existing empty or invalid
// policy volume refuses startup instead of silently selecting that path.
export async function readRuntimePolicy(directory, env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new RuntimePolicyError();
  let stat;
  try { stat = await lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new RuntimePolicyError(); }
  try {
    assertDirectory(stat);
    const file = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > RUNTIME_POLICY_MAX_BYTES || (stat.mode & 0o022)) throw new RuntimePolicyError();
      return decodeRuntimePolicy(await file.readFile(), env);
    } finally { await file.close(); }
  } catch { throw new RuntimePolicyError(); }
}

// The host invokes this only with the dedicated policy volume while stopped.
// The policy is installation data; the host catalog still authorizes its image.
// createOnly never replaces or repairs: it requires an existing empty directory
// owned by this user and publishes without overwrite. Emptiness is not proof of
// physical freshness; the caller owns fresh inventory and exclusion.
export async function writeRuntimePolicy(directory, input, { createOnly = false } = {}) {
  const policy = validateRuntimePolicy(input), text = JSON.stringify(policy) + '\n';
  if (Buffer.byteLength(text) > RUNTIME_POLICY_MAX_BYTES) throw new RuntimePolicyError();
  try {
    const stat = await lstat(directory);
    assertDirectory(stat);
    if (createOnly) await assertFresh(directory, stat);
    await chmod(directory, 0o700);
    if (createOnly) await writeAtomicFile(join(directory, filename), text, { createOnly: true, createDirectory: false });
    else await atomicPolicyFile(directory, text);
    return { family: policy.family, admission: policy.admission, identitySha256: runtimePolicyIdentity(policy) };
  } catch {
    const error = new Error('Could not durably install runtime policy; keep the installation stopped');
    error.code = 'RUNTIME_POLICY_WRITE_FAILED'; throw error;
  }
}
function assertDirectory(stat) {
  if (!stat.isDirectory() || (stat.mode & 0o022)) throw new RuntimePolicyError();
}
async function assertFresh(directory, stat) {
  if (stat.uid !== process.geteuid() || (await readdir(directory)).length) throw new RuntimePolicyError();
}
async function atomicPolicyFile(directory, text) {
  const temporary = join(directory, `${randomUUID()}.tmp`);
  let owned = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    owned = true;
    try { await file.writeFile(text); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, join(directory, filename));
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { if (owned) await rm(temporary, { force: true }); }
}
