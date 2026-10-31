import { randomBytes } from 'node:crypto';
import { mkdir, lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes, digest, privateJSON } from '../build-cache/paths.mjs';
import { bindHostDirectory, checkHostDirectory, syncHostDirectory } from '../runtime/host-directory.mjs';
import { readPreviewInputs } from './inputs.mjs';
import { issueVerifiedPreviewExecution } from './decision.mjs';
import { createPreviewExecutionAuthority, previewExecutionSha256 } from './execution-authority.mjs';
import { executionKeys } from './execution-shape.mjs';
import { validatePreviewSecrets } from './control-input.mjs';
import { previewTLS } from './ingress.mjs';
import { createPreviewPlan, validatePreviewPlan, previewPlanTarget } from './plan.mjs';
import { previewRuntimeFamily, bindPreviewRuntime } from './runtime-catalog.mjs';
import { assertCurrentPreviewStorage } from './storage-binding.mjs';
import { previewServiceCommands } from './container-plan.mjs';
import { preparePreviewInputPackage, previewInputPackageLimit } from './input-package.mjs';
import { previewInputJSON } from './input-files.mjs';
import { checkPreviewOwnerControlLocation } from './owner-control.mjs';

export const previewLaunchRequestLimit = previewInputPackageLimit + 1024 ** 2;
const fields = ['root', 'directory', 'runtime', 'plan', 'envelope', 'bundle', 'publicKey', 'expectedGrantSha256', 'secretValues', 'ownerControl', 'expectedImage'];
const names = ['access.json', 'launch.json', 'request.complete.json'];
function refuse() {
  const error = new Error('Preview launch request refused; retain private files and the original request fingerprint');
  error.code = 'PREVIEW_LAUNCH_REQUEST_REFUSED'; throw error;
}
function tlsPair(input, hostname) {
  executionKeys(input, ['cert', 'key']);
  const pair = previewTLS(input, hostname);
  return { cert: pair.cert, key: pair.key };
}
function accessRecord(configuration) {
  const { source, preview, expiresAt } = configuration.envelope.grant;
  return { schema: 1, kind: 'fogd-preview-access', preview, app: source.app, submission: source.submission, digest: source.digest,
    origin: configuration.plan.request.origin, expiresAt, accessKey: configuration.bundle.ingress.accessKey, ca: configuration.bundle.ingress.tls.cert };
}
function completion(configuration, requestSha256, accessSha256) {
  return { schema: 1, kind: 'fogd-preview-launch-request-completion', preview: configuration.envelope.grant.preview,
    execution: configuration.envelope.grant.id, requestSha256, accessSha256 };
}
async function persist(output, configuration) {
  const data = { schema: 1, kind: 'fogd-preview-launch-inputs', ...configuration }, requestBytes = jsonBytes(data);
  if (Buffer.byteLength(requestBytes) > previewLaunchRequestLimit) refuse();
  const parent = await bindHostDirectory(dirname(output)); await checkHostDirectory(parent);
  await mkdir(output, { mode: 0o700 }); await syncHostDirectory(parent);
  const bound = await bindHostDirectory(output), access = accessRecord(configuration);
  const requestSha256 = hash(requestBytes), accessSha256 = hash(jsonBytes(access));
  await privateJSON(join(output, 'launch.json'), data);
  await privateJSON(join(output, 'access.json'), access);
  await syncHostDirectory(bound);
  await privateJSON(join(output, 'request.complete.json'), completion(configuration, requestSha256, accessSha256));
  await syncHostDirectory(bound);
  return { schema: 1, kind: 'fogd-preview-launch-request', directory: output, requestSha256,
    preview: configuration.envelope.grant.preview, execution: configuration.envelope.grant.id,
    origin: access.origin, expiresAt: access.expiresAt, accessFile: join(output, 'access.json'),
    ownerControlDirectory: configuration.ownerControl.directory, runtimeStarted: false, memoryReserved: false, productionActivation: false };
}

// Owner action: signs one exact target. Source credentials and the ephemeral
// signing private key are never persisted. Memory/runtime admission is separate.
export async function createPreviewLaunchRequest(input) {
  try {
    input = { ...input, env: { ...input.env }, tls: structuredClone(input.tls), secrets: structuredClone(input.secrets ?? {}),
      storage: structuredClone(input.storage), subnets: structuredClone(input.subnets) };
    const root = (await bindHostDirectory(input.root)).canonical, directory = (await bindHostDirectory(input.directory)).canonical;
    const { env, tls, secrets } = input;
    const runtime = previewRuntimeFamily(input.runtime, { candidateEnrollment: input.candidateEnrollment });
    const output = await checkPreviewOwnerControlLocation({ root, directory }, { directory: input.output, dockerContext: input.dockerContext });
    const inputs = await readPreviewInputs(directory, input.expectedPreparationSha256);
    executionKeys(tls, ['gateway', 'ingress']); validatePreviewSecrets(inputs.preparation, secrets);
    const hostname = new URL(input.origin).hostname, gatewayTLS = tlsPair(tls.gateway, hostname), ingressTLS = tlsPair(tls.ingress, hostname);
    const authority = createPreviewExecutionAuthority(), storagePassword = randomBytes(32).toString('hex'), gatewayToken = randomBytes(32).toString('hex'), accessKey = randomBytes(32).toString('hex');
    const plan = createPreviewPlan({ preparation: inputs.preparation, preparationSha256: input.expectedPreparationSha256,
      storage: input.storage, engineId: input.engineId, image: runtime.image, origin: input.origin, subnets: input.subnets,
      fingerprints: { authorityPublicKey: hash(authority.publicKey), artifact: hash(jsonBytes(inputs.artifact)), previewSecrets: hash(jsonBytes(secrets)),
        storagePassword: hash(storagePassword), gatewayToken: hash(gatewayToken), viewerAccessKey: hash(accessKey),
        gatewayTLS: hash(jsonBytes(gatewayTLS)), ingressTLS: hash(jsonBytes(ingressTLS)) } });
    bindPreviewRuntime(plan, runtime.id, input.candidateEnrollment);
    await assertCurrentPreviewStorage(plan, input.runStorageHost, 'empty');
    const issued = await issueVerifiedPreviewExecution({ directory, expectedPreparationSha256: input.expectedPreparationSha256, env,
      target: previewPlanTarget(plan), privateKey: authority.privateKey });
    const bundle = { envelope: issued.envelope, artifact: issued.artifact, secrets,
      gateway: { tls: gatewayTLS, gatewayToken }, ingress: { tls: ingressTLS, accessKey, upstreamCA: gatewayTLS.cert } };
    const configuration = { root, directory, runtime: runtime.id, plan, envelope: issued.envelope, bundle,
      publicKey: authority.publicKey, expectedGrantSha256: previewExecutionSha256(issued.envelope), secretValues: { storagePassword, gatewayToken },
      ownerControl: { directory: join(output, 'control'), dockerContext: input.dockerContext }, expectedImage: runtime.image };
    await checkedConfiguration({ schema: 1, kind: 'fogd-preview-launch-inputs', ...configuration }, input.candidateEnrollment);
    if (await checkPreviewOwnerControlLocation({ root, directory }, { directory: output, dockerContext: input.dockerContext }) !== output) refuse();
    return await persist(output, configuration);
  } catch { refuse(); }
}

async function checkedConfiguration(data, candidateEnrollment) {
  executionKeys(data, ['schema', 'kind', ...fields]);
  if (data.schema !== 1 || data.kind !== 'fogd-preview-launch-inputs') refuse();
  const configuration = Object.fromEntries(fields.map(key => [key, data[key]]));
  executionKeys(configuration.ownerControl, ['directory', 'dockerContext']);
  executionKeys(configuration.secretValues, ['storagePassword', 'gatewayToken']);
  if (typeof configuration.ownerControl.dockerContext !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(configuration.ownerControl.dockerContext) ||
    (await bindHostDirectory(configuration.root)).canonical !== configuration.root ||
    (await bindHostDirectory(configuration.directory)).canonical !== configuration.directory) refuse();
  const plan = validatePreviewPlan(configuration.plan);
  bindPreviewRuntime(plan, configuration.runtime, candidateEnrollment);
  if (configuration.expectedImage !== plan.request.image) refuse();
  const commands = previewServiceCommands(plan, configuration.envelope, configuration);
  const authority = JSON.parse(commands['input-installer'].configuration.command[2]);
  await preparePreviewInputPackage(authority, configuration.bundle);
  return configuration;
}
async function privateInput(bound, name, limit, expected) {
  await checkHostDirectory(bound);
  const path = join(bound.canonical, name), before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== process.geteuid() || (before.mode & 0o7777) !== 0o600 || before.size > limit) refuse();
  const value = await previewInputJSON(path, limit, expected), after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs || before.size !== after.size) refuse();
  await checkHostDirectory(bound);
  return value;
}

// Read for a new launch only: expiry and runtime admission are checked again.
// The independently retained fingerprint cannot come from these same files.
export async function readPreviewLaunchRequest(directory, expectedRequestSha256, { candidateEnrollment = false } = {}) {
  try {
    if (!digest(expectedRequestSha256)) refuse();
    const bound = await bindHostDirectory(resolve(directory)), members = (await readdir(bound.canonical)).sort();
    if (!isDeepStrictEqual(members.filter(name => name !== 'control'), names)) refuse();
    if (members.includes('control')) await bindHostDirectory(join(bound.canonical, 'control'));
    const data = await privateInput(bound, 'launch.json', previewLaunchRequestLimit, expectedRequestSha256);
    const configuration = await checkedConfiguration(data, candidateEnrollment);
    if (configuration.ownerControl.directory !== join(bound.canonical, 'control')) refuse();
    const access = await privateInput(bound, 'access.json', 65536);
    if (!isDeepStrictEqual(access, accessRecord(configuration))) refuse();
    const recorded = await privateInput(bound, 'request.complete.json', 16384);
    if (!isDeepStrictEqual(recorded, completion(configuration, expectedRequestSha256, hash(jsonBytes(access))))) refuse();
    return { configuration, requestSha256: expectedRequestSha256 };
  } catch { refuse(); }
}
