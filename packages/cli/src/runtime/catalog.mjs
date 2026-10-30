import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { verifyCronRuntimeImage, verifyCronStorageImage, runtimeInspector } from './cron-image.mjs';
import { programInventory } from './program-inventory.mjs';
import { validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { docker } from '../recovery/docker.mjs';

const fields = ['schema', 'id', 'admission', 'os', 'architecture', 'image', 'storageImage', 'parentImage', 'binarySha256', 'supervisorSha256', 'sourceFiles'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const image = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

// Catalog modes bind policy schemas: legacy, durable, and archive controller.
const entryFields = { 1: fields, 2: [...fields, 'routing'], 3: [...fields, 'routing'] };
// Installed policy schema -> catalog entry schema carrying that execution mode.
const policyEntrySchema = { 2: 1, 3: 2, 4: 3 };

export function validateRuntimeFamily(input) {
  const expected = [1, 2, 3].includes(input?.schema) ? entryFields[input.schema] : null;
  if (!expected || !isDeepStrictEqual(Object.keys(input).sort(), [...expected].sort()) ||
    ([2, 3].includes(input.schema) && input.routing !== 'durable') ||
    !/^[a-z][a-z0-9-]{1,63}$/.test(input.id || '') || !['candidate', 'qualified'].includes(input.admission) ||
    input.os !== 'linux' || input.architecture !== 'arm64' || !['image', 'storageImage', 'parentImage'].every(key => image(input[key])) ||
    !digest(input.binarySha256) || !digest(input.supervisorSha256)) throw new Error('Invalid shipped runtime family');
  assertSources(input.sourceFiles, input.schema);
  return structuredClone(input);
}
function assertSources(files, schema) {
  if (!files || typeof files !== 'object' || Array.isArray(files) ||
    !['platform', 'runtime'].every(name => Object.hasOwn(files, `packages/${name}/package.json`))) throw new Error('Missing shipped runtime source inventory');
  if (schema === 3 && !Object.hasOwn(files, 'packages/platform/src/main-archive.mjs')) throw new Error('Invalid shipped runtime family: archive controller entrypoint source is missing');
  for (const [path, hash] of Object.entries(files)) {
    if (!/^packages\/(?:platform|runtime)\/(?:package\.json|src\/[A-Za-z0-9._/-]+\.(?:mjs|js))$/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..') || !digest(hash)) throw new Error('Invalid shipped runtime source inventory');
  }
}

const shipped = JSON.parse(await readFile(new URL('./catalog.json', import.meta.url), 'utf8')).map(validateRuntimeFamily);
if (new Set(shipped.map(entry => entry.id)).size !== shipped.length || new Set(shipped.map(entry => entry.image)).size !== shipped.length) throw new Error('Ambiguous shipped runtime catalog');

export function runtimeFamilies() { return structuredClone(shipped); }
export function requestedRuntime({ runtime, candidateEnrollment = false }) {
  if (typeof candidateEnrollment !== 'boolean' || (candidateEnrollment && runtime === undefined)) throw new Error('Candidate enrollment requires an explicit known runtime family');
  if (runtime === undefined) return null;
  if (typeof runtime !== 'string' || !runtime) throw new Error('Runtime family must be a nonempty shipped family name');
  return runtimeFamily(runtime, candidateEnrollment ? 'candidate' : 'new');
}
export function runtimeFamily(name, intent = 'new') {
  return selectFamily(shipped, name, intent);
}
export function selectFamily(entries, name, intent = 'new') {
  const entry = entries.find(item => item.id === name);
  if (!entry || !['new', 'candidate', 'enrolled'].includes(intent)) throw new Error('Unknown shipped runtime family');
  if (intent === 'new' && entry.admission !== 'qualified') throw new Error('Runtime family is a candidate; ordinary enrollment remains closed');
  return structuredClone(entry);
}
export function authorizeInstalledPolicy(input) {
  const policy = validateRuntimePolicy(input);
  return authorizePolicyEntry(policy, runtimeFamily(policy.family, 'enrolled'));
}
// Pure binding of a validated installed policy to one catalog entry, including execution mode.
export function authorizePolicyEntry(input, candidate) {
  const policy = validateRuntimePolicy(input), entry = validateRuntimeFamily(candidate);
  if (policy.family !== entry.id || policyEntrySchema[policy.schema] !== entry.schema) throw new Error('Installed runtime policy differs from the shipped catalog; keep the installation stopped');
  for (const key of ['image', 'storageImage', 'binarySha256', 'supervisorSha256']) {
    if (policy[key] !== entry[key]) throw new Error('Installed runtime policy differs from the shipped catalog; keep the installation stopped');
  }
  return entry;
}
export async function verifyRuntimeFamily(entry, run) {
  entry = validateRuntimeFamily(entry);
  await verifyRuntimeHost(run);
  await verifyCronStorageImage(entry.storageImage, run);
  await verifyCronRuntimeImage(entry, run);
  try {
    const code = `(${programInventory.toString()})('/app', true).then(files => console.log(JSON.stringify(files)));`;
    const actual = JSON.parse(await runtimeInspector(entry.image, code, run));
    if (!isDeepStrictEqual(actual, entry.sourceFiles)) throw new Error('Runtime source inventory differs');
  } catch { throw new Error('Shipped runtime source verification failed; no application runtime was started'); }
}

export async function verifyRuntimeHost(run = docker) {
  const host = JSON.parse(await run(['info', '--format', '{{json .}}'], { timeoutMs: 15000 }));
  assertRuntimeHost(host);
  return host;
}
export function assertRuntimeHost(host) {
  if (host.OSType !== 'linux' || !['aarch64', 'arm64'].includes(host.Architecture)) throw new Error('Shipped runtime requires a Linux arm64 Docker host');
}
