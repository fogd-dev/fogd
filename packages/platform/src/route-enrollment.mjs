import { constants } from 'node:fs';
import { open, lstat, realpath, opendir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runtimePolicyIdentity, validateRuntimePolicy } from './runtime-policy.mjs';

const grantFile = 'route-enrollment.json', spentFile = 'route-enrollment.spent.json';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const refused = () => Object.assign(new Error('Route enrollment requires matching private, fresh, independently bound initialization storage'), { code: 'ROUTE_ENROLLMENT_REFUSED' });
const spent = () => Object.assign(new Error('Route enrollment grant is already spent or uncertain; retain its storage and do not replay initialization'), { code: 'ROUTE_ENROLLMENT_SPENT' });
const uncertain = () => Object.assign(new Error('Route enrollment persistence is uncertain; keep ingress stopped and retain all enrollment storage'), { code: 'ROUTE_ENROLLMENT_UNCERTAIN' });
function contains(parent, child) {
  const path = relative(parent, child);
  return !path || path !== '..' && !path.startsWith('..' + sep);
}
async function directory(path, publicReadable) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw refused();
  const stat = await lstat(path, { bigint: true });
  const permissions = Number(stat.mode & 0o777n);
  if (!stat.isDirectory() || stat.uid !== BigInt(process.geteuid()) || permissions !== (publicReadable ? 0o755 : 0o700)) throw refused();
  return { path: await realpath(path), device: stat.dev.toString(), inode: stat.ino.toString() };
}
async function empty(path) {
  const dir = await opendir(path);
  try { if (await dir.read()) throw refused(); } finally { await dir.close(); }
}
// Retained route stores must stay on the directories selected by enrollment.
// This comparison is not a substitute for the launcher's writer exclusion.
export async function assertRouteEnrollmentTargets(targets, controller, authority) {
  try {
    if (!keys(targets, ['controller', 'authority'])) throw refused();
    const actual = { controller: await directory(controller, false), authority: await directory(authority, true) };
    if (!isDeepStrictEqual(targets, actual)) throw refused();
  } catch { throw refused(); }
}
async function enrollmentTargets({ controller, authority, enrollment }) {
  const targets = { controller: await directory(controller, false), authority: await directory(authority, true), enrollment: await directory(enrollment, false) };
  const identities = Object.values(targets);
  if (new Set(identities.map(value => `${value.device}:${value.inode}`)).size !== identities.length) throw refused();
  const paths = identities.map(value => value.path);
  if (paths.some((path, index) => paths.some((other, otherIndex) => index !== otherIndex && contains(path, other)))) throw refused();
  return targets;
}
async function exclusiveRecord(directory, name, value) {
  const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const file = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.chmod(0o600); await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await parent.sync();
  } finally { await parent.close(); }
}
async function grantRecord(directory) {
  const file = await open(join(directory, grantFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat(), buffer = Buffer.alloc(32769);
    if (!stat.isFile() || stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 32768) throw refused();
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw refused();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } finally { await file.close(); }
}
function expected(input, spending = false) {
  if (!keys(input, ['profile', 'binding', 'controller', 'authority', 'enrollment', ...(spending ? ['id'] : [])]) || spending && !uuid(input.id)) throw refused();
  if (!hex(input.binding)) throw refused();
  const profile = validateRuntimePolicy(input.profile);
  return { profile, installation: runtimePolicyIdentity(profile), binding: input.binding };
}
async function enrollmentContext(input, spending) {
  try { return { target: expected(input, spending), targets: await enrollmentTargets(input) }; }
  catch (error) { if (error.code === 'RUNTIME_POLICY_REFUSED') throw error; throw refused(); }
}
function matching(grant, target, targets, id) {
  return keys(grant, ['schema', 'id', 'installation', 'binding', 'targets', 'profile']) && grant.schema === 1 && uuid(grant.id) && grant.id === id &&
    grant.installation === target.installation && grant.binding === target.binding && isDeepStrictEqual(grant.targets, targets) && isDeepStrictEqual(grant.profile, target.profile);
}
// The host must authorize a fresh, stopped, exclusively owned mount inventory
// before issuing this grant. A directory inspection or binding string is no proof
// of those external facts. Enrollment control storage is never an app backup.
export async function issueRouteEnrollment(input) {
  const { target, targets } = await enrollmentContext(input, false);
  try { await Promise.all(Object.values(targets).map(value => empty(value.path))); } catch { throw refused(); }
  const grant = { schema: 1, id: randomUUID(), ...target, targets };
  try { await exclusiveRecord(targets.enrollment.path, grantFile, grant); }
  catch (error) { if (error.code === 'EEXIST') throw refused(); throw uncertain(); }
  return { id: grant.id, installation: grant.installation, binding: grant.binding };
}
// Presence of the spent marker is final, including an incomplete marker left by
// interruption. It is synced before the caller may create either routing store.
export async function spendRouteEnrollment(input) {
  const { target, targets } = await enrollmentContext(input, true);
  if (await hasSpentMarker(targets)) throw spent();
  return spendAvailable(target, targets, input.id);
}
async function hasSpentMarker(targets) {
  try { await lstat(join(targets.enrollment.path, spentFile)); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw refused(); return false; }
}
async function spendAvailable(target, targets, id) {
  let grant;
  try {
    grant = await grantRecord(targets.enrollment.path);
    if (!matching(grant, target, targets, id)) throw refused();
    await Promise.all([empty(targets.controller.path), empty(targets.authority.path)]);
  } catch {
    if (await hasSpentMarker(targets)) throw spent();
    throw refused();
  }
  try { await exclusiveRecord(targets.enrollment.path, spentFile, { schema: 1, id: grant.id, installation: target.installation, binding: target.binding }); }
  catch (error) { if (error.code === 'EEXIST') throw spent(); throw uncertain(); }
  return { id: grant.id, ...target, targets };
}
