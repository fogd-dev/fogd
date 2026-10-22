import { manifest } from '@fogd/runtime/manifest';
import { buildArtifact, artifactProject, configEnv, stackRoot, serverOrigin } from './local.mjs';
import { deployCapabilities } from './deploy-capabilities.mjs';
import { submitManagedBuild } from './build-cache/lifecycle.mjs';
import { controllerOrigin } from './build-cache/paths.mjs';
import { boundedJson, discardResponse } from './client-http.mjs';

export async function deploy(project, name) {
  const env = await configEnv();
  if (!env.FOGD_DEPLOY_TOKEN) throw new Error('Set FOGD_DEPLOY_TOKEN (local operators: run fogd up first)');
  const origin = controllerOrigin(serverOrigin(env));
  const { app } = await artifactProject(project, name);
  const capabilities = await deployCapabilities(origin, env.FOGD_DEPLOY_TOKEN, app);
  const release = await buildArtifact(project, app, capabilities);
  const { result, receiptSaved } = await submitManagedBuild(stackRoot, release, origin, () => upload(origin, env.FOGD_DEPLOY_TOKEN, release));
  if (!receiptSaved) console.warn('Controller returned a submission ID, but the local build receipt could not be confirmed. Keep its output; use the returned submission ID rather than submitting again.');
  console.log(JSON.stringify({ id: result.id, app: result.app, digest: result.digest, status: result.status, admin: origin, localBuildId: release.localBuildId }, null, 2));
}

async function upload(origin, token, release) {
  const body = JSON.stringify(await manifest(release.outputDir, release));
  let response;
  try {
    response = await fetch(`${origin}/v1/deployments`, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(900000) });
  } catch { throw new Error('Submission transport failed; keep the local build and inspect controller state before submitting again'); }
  if (!response.ok) {
    await discardResponse(response);
    throw new Error(`Submission refused (HTTP ${response.status}); keep the local build and inspect controller state before submitting again`);
  }
  return boundedJson(response, { limit: 64 * 1024, invalid: 'Controller returned an unreadable submission receipt; keep the local build and inspect controller state before submitting again' });
}
