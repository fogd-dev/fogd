import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { receiveArtifact, MAX_UPLOAD } from '@fogd/runtime/manifest';
import { hash, digest } from '../build-cache/paths.mjs';
import { authorizePreviewExecution, validatePreviewRelease } from './execution.mjs';
import { executionKeys, refuseExecution } from './execution-shape.mjs';
import { previewInputJSON as inputJSON, previewInputDirectory } from './input-files.mjs';
import { previewBackendCommand } from './backend.mjs';

function checkedTrust(trust) {
  executionKeys(trust, ['schema', 'role', 'publicKey', 'expectedGrantSha256', 'preparationSha256', 'target', 'artifactSha256', 'secretsSha256', 'storagePasswordSha256', 'gatewayTokenSha256']);
  if (trust.schema !== 1 || trust.role !== 'controller' ||
    !['artifactSha256', 'secretsSha256', 'storagePasswordSha256', 'gatewayTokenSha256'].every(key => digest(trust[key]))) refuseExecution();
}

function checkedEnvironment(grant, trust, env) {
  const id = grant.preview.replaceAll('-', '');
  if (env.FOGD_PREVIEW_ID !== id || env.FOGD_PREVIEW_EXPIRES_AT !== grant.expiresAt ||
    typeof env.FOGD_PREVIEW_GATEWAY_TOKEN !== 'string' || !/^[a-f0-9]{64}$/.test(env.FOGD_PREVIEW_GATEWAY_TOKEN) ||
    hash(env.FOGD_PREVIEW_GATEWAY_TOKEN) !== trust.gatewayTokenSha256 || hash(env.FOGD_PREVIEW_STORAGE_PASSWORD || '') !== trust.storagePasswordSha256) refuseExecution();
  return previewBackendCommand('bucket-init', env).env;
}

function checkedSecrets(grant, values) {
  executionKeys(values, grant.policy.requiredSecrets);
  if (Object.values(values).some(value => typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 8192) || Buffer.byteLength(JSON.stringify(values)) > 32768) refuseExecution();
}

// The host installs trust independently in a read-only authority volume. Artifact
// input and workload volumes cannot supply or replace that public key/target.
export async function readPreviewControl({ trustDirectory, inputDirectory, env }) {
  try {
    await previewInputDirectory(trustDirectory); await previewInputDirectory(inputDirectory);
    const trust = await inputJSON(join(trustDirectory, 'trust.json'), 16384); checkedTrust(trust);
    const envelope = await inputJSON(join(inputDirectory, 'execution.json'), 16384);
    const grant = authorizePreviewExecution(envelope, trust), storage = checkedEnvironment(grant, trust, env);
    const artifact = await inputJSON(join(inputDirectory, 'artifact.json'), 2 * MAX_UPLOAD, trust.artifactSha256);
    const secrets = await inputJSON(join(inputDirectory, 'secrets.json'), 65536, trust.secretsSha256); checkedSecrets(grant, secrets);
    const temporary = await mkdtemp(join(tmpdir(), 'fogd-preview-control-'));
    try {
      const release = await receiveArtifact(artifact, temporary, { cronApps: false });
      validatePreviewRelease(grant, release);
      return { grant, artifact, secrets, storage, gatewayToken: env.FOGD_PREVIEW_GATEWAY_TOKEN };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  } catch { refuseExecution(); }
}
