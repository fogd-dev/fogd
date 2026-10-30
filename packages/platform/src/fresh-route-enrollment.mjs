import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hasDurableRuntimeMode, validateRuntimePolicy } from './runtime-policy.mjs';
import { issueRouteEnrollment } from './route-enrollment.mjs';
import { initializeRouteEnrollment } from './route-initialize.mjs';

const refused = () => Object.assign(new Error('Fresh route enrollment requires empty, owned, disjoint durable route storage; keep ingress stopped and retain the storage'), { code: 'ROUTE_ENROLLMENT_REFUSED' });
const modes = { controller: 0o700, authority: 0o755, enrollment: 0o700 };

function freshInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !isDeepStrictEqual(Object.keys(input).sort(), ['binding', 'profile'])) throw refused();
  if (typeof input.binding !== 'string' || !/^[a-f0-9]{64}$/.test(input.binding)) throw refused();
  let policy;
  try { policy = validateRuntimePolicy(input.profile); } catch { throw refused(); }
  if (!hasDurableRuntimeMode(policy)) throw refused();
  return { profile: input.profile, binding: input.binding };
}
function contains(parent, child) {
  const path = relative(parent, child);
  return !path || path !== '..' && !path.startsWith('..' + sep);
}
async function empty(path) {
  const dir = await opendir(path);
  try { return !(await dir.read()); } finally { await dir.close(); }
}
// Opened without following links; the handle is the object later chmodded.
async function ownedEmpty(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || stat.uid !== BigInt(process.geteuid()) || !await empty(path)) throw refused();
    return { handle, path: await realpath(path), identity: `${stat.dev}:${stat.ino}` };
  } catch (error) { await handle.close(); throw error; }
}
async function inspectTargets(paths) {
  const targets = {};
  try {
    for (const [role, path] of Object.entries(paths)) targets[role] = await ownedEmpty(path);
    const values = Object.values(targets);
    if (new Set(values.map(value => value.identity)).size !== values.length) throw refused();
    if (values.some(left => values.some(right => left !== right && contains(left.path, right.path)))) throw refused();
    return targets;
  } catch { await closeTargets(targets); throw refused(); }
}
const closeTargets = targets => Promise.all(Object.values(targets).map(value => value.handle.close()));

// The caller must already have proved fresh, owned, stopped mounts of the pinned
// image with exclusive writers; local inspection cannot prove those facts.
// Paths and the publisher are trusted options, never taken from serialized input.
// The function creates the grant, spent marker and initial route stores in
// existing empty directories. Retained grants and data are preserved.
export async function initializeFreshRouteStores(input, { controller = '/var/lib/fogd', authority = '/var/lib/fogd-routes', enrollment = '/var/lib/fogd-enrollment', createPublic } = {}) {
  if (createPublic !== undefined && typeof createPublic !== 'function') throw refused();
  const request = freshInput(input), paths = { controller, authority, enrollment };
  if (!Object.values(paths).every(path => typeof path === 'string' && isAbsolute(path))) throw refused();
  const targets = await inspectTargets(paths);
  try { await Promise.all(Object.entries(targets).map(([role, value]) => value.handle.chmod(modes[role]))); }
  catch { throw refused(); }
  finally { await closeTargets(targets); }
  const grant = await issueRouteEnrollment({ ...request, ...paths });
  return initializeRouteEnrollment({ ...request, ...paths, id: grant.id }, { createPublic });
}
