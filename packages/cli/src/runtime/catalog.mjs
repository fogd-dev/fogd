import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { verifyCronRuntimeImage, verifyCronStorageImage, runtimeInspector } from './cron-image.mjs';
import { programInventory } from './program-inventory.mjs';
import { validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { docker } from '../recovery/docker.mjs';

const fields = ['schema', 'id', 'admission', 'os', 'architecture', 'image', 'storageImage', 'parentImage', 'binarySha256', 'supervisorSha256', 'sourceFiles'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const image = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

export function validateRuntimeFamily(input) {
  if (!input || !isDeepStrictEqual(Object.keys(input).sort(), [...fields].sort()) || input.schema !== 1 ||
    !/^[a-z][a-z0-9-]{1,63}$/.test(input.id || '') || !['candidate', 'qualified'].includes(input.admission) ||
    input.os !== 'linux' || input.architecture !== 'arm64' || !['image', 'storageImage', 'parentImage'].every(key => image(input[key])) ||
    !digest(input.binarySha256) || !digest(input.supervisorSha256)) throw new Error('Invalid shipped runtime family');
  assertSources(input.sourceFiles);
  return structuredClone(input);
}
function assertSources(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files) ||
    !['platform', 'runtime'].every(name => Object.hasOwn(files, `packages/${name}/package.json`))) throw new Error('Missing shipped runtime source inventory');
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
  const entry = runtimeFamily(policy.family, 'enrolled');
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
  if (host.OSType !== 'linux' || !['aarch64', 'arm64'].includes(host.Architecture)) throw new Error('Shipped runtime requires a Linux arm64 Docker host');
  return host;
}
