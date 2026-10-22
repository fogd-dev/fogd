import { submitManagedBuild } from './build-cache/lifecycle.mjs';
import { adminInspect } from './inspect-command.mjs';
import { assertSharedStorageConfiguration } from './shared-storage.mjs';
import { resolvedCompose } from './compose/config.mjs';
import { checkFleetSelection } from './compose/selection.mjs';
import { transportPolicy } from '@fogd/runtime/transport';
import { prepareEnvironment } from './bootstrap.mjs';
import { checkInstalledTLS } from './tls.mjs';
import { readSecretInput } from './secret-input.mjs';
import { deployCapabilities } from './deploy-capabilities.mjs';
import { selectedInstallation } from './runtime/installation.mjs';
import { docker } from './recovery/docker.mjs';
import { requestedRuntime } from './runtime/catalog.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { join } from 'node:path';
import { manifest } from '@fogd/runtime/manifest';
import { buildArtifact, artifactProject, requireDocker, configEnv, configPath, compose, stackRoot, serverOrigin as origin } from './local.mjs';

export async function up(shared = false, selection = {}) {
  requestedRuntime(selection);
  const env = await prepareEnvironment(shared);
  requireDocker(env);
  const raw = await resolvedCompose(env);
  assertSharedStorageConfiguration(raw);
  await checkFleetSelection(raw);
  const policy = transportPolicy(env);
  const selected = await selectedInstallation(raw, selection), config = selected?.config || raw;
  const launch = transportPolicy(config.services.controller.environment);
  if (launch.profile !== policy.profile || launch.tls !== policy.tls) throw new Error('Configuration does not match the requested TLS/profile policy');
  if (policy.tls) await checkInstalledTLS(env, config);
  if (selected) await docker([...selected.command, 'up', '-d', '--no-build', '--pull', 'never']);
  else await compose(['up', '-d', '--build'], env);
  if (selected) console.log(`Runtime ${selected.entry.id} (${selected.entry.admission}); installation identity ${runtimePolicyIdentity(selected.policy)}`);
  console.log(`Stack started. Admin: ${origin(env)} (user ${env.FOGD_ADMIN_USER || 'admin'}, password in ${configPath()}).\nRun fogd deploy in a Void app; an admin must approve its digest.`);
}
async function api(env, path, options = {}) {
  const response = await fetch(`${origin(env)}${path}`, { ...options, signal: AbortSignal.timeout(900000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
export async function deploy(project, name) {
  const env = await configEnv();
  if (!env.FOGD_DEPLOY_TOKEN) throw new Error('Set FOGD_DEPLOY_TOKEN (local operators: run fogd up first)');
  const { app } = await artifactProject(project, name);
  const capabilities = await deployCapabilities(origin(env), env.FOGD_DEPLOY_TOKEN, app);
  const release = await buildArtifact(project, app, capabilities);
  const { result, receiptSaved } = await submitManagedBuild(stackRoot, release, origin(env), async () => api(env, '/v1/deployments', { method: 'POST', headers: { Authorization: `Bearer ${env.FOGD_DEPLOY_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(await manifest(release.outputDir, release)) }));
  if (!receiptSaved) console.warn('Controller returned a submission ID, but the local build receipt could not be confirmed. Keep its output; use the returned submission ID rather than submitting again.');
  console.log(JSON.stringify({ id: result.id, app: result.app, digest: result.digest, status: result.status, admin: origin(env), localBuildId: release.localBuildId }, null, 2));
}
export async function status(id) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || '')) throw new Error('Usage: fogd status <deployment-id>');
  const env = await configEnv();
  if (!env.FOGD_DEPLOY_TOKEN) throw new Error('Set FOGD_DEPLOY_TOKEN');
  const result = await api(env, `/v1/deployments/${id}`, { headers: { Authorization: `Bearer ${env.FOGD_DEPLOY_TOKEN}` } });
  console.log(JSON.stringify(result, null, 2));
}
export async function admin(action, id, digest, secretRevision) {
  if (action === 'inspect') return adminInspect(id, digest, secretRevision);
  const { env, headers, state } = await adminSession();
  if (action === 'capacity') {
    showCapacity(state, [id, digest, secretRevision]); return;
  }
  if (action === 'list') {
    console.log(JSON.stringify({ deployments: Object.values(state.deployments), secrets: state.secrets, credentials: state.credentials, quota: state.quota }, null, 2)); return;
  }
  if (['issue-token', 'revoke-token'].includes(action)) {
    await manageCredential(env, headers, state.csrf, action, id, digest, secretRevision); return;
  }
  if (action === 'secrets') {
    await manageSecrets(env, headers, state.csrf, id, digest, secretRevision); return;
  }
  await decideDeployment(env, headers, state, action, id, digest, secretRevision);
}

async function decideDeployment(env, headers, state, action, id, digest, secretRevision, replaces) {
  if (!['approve', 'reject'].includes(action) || !id || !digest) throw new Error('Usage: fogd admin list | approve|reject <id> <digest>');
  if (action === 'approve' && state.deployments[id]?.requiredSecrets?.length && !secretRevision) throw new Error('Approval requires an explicit secret revision: fogd admin approve ID SHA SECRET_REVISION (see fogd admin list)');
  const result = await api(env, `/v1/deployments/${id}/${action}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Fogd-CSRF': state.csrf }, body: JSON.stringify({ digest, secretRevision: secretRevision || null, ...(replaces ? { replaces } : {}) }) });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'failed') throw new Error('Activation failed; inspect the error above and explicitly approve again to retry');
}

async function manageCredential(env, headers, csrf, action, id, apps, extra) {
  if (!id || extra || (action === 'issue-token' ? !apps : apps)) throw new Error('Usage: fogd admin issue-token NAME APP[,APP] | revoke-token ID');
  const path = action === 'issue-token' ? '/v1/credentials' : `/v1/credentials/${encodeURIComponent(id)}/revoke`;
  const data = action === 'issue-token' ? { name: id, apps: apps.split(',') } : {};
  const result = await api(env, path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Fogd-CSRF': csrf }, body: JSON.stringify(data) });
  console.log(JSON.stringify(result, null, 2));
}

async function manageSecrets(env, headers, csrf, id, digest, revision) {
  if (!id || digest || revision) throw new Error('Usage: fogd admin secrets APP < values.json');
  const values = await readSecretInput();
  const result = await api(env, `/v1/apps/${encodeURIComponent(id)}/secrets`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json', 'X-Fogd-CSRF': csrf }, body: JSON.stringify(values) });
  console.log(JSON.stringify(result, null, 2));
}

function showCapacity(state, extra) {
  if (extra.some(value => value !== undefined)) throw new Error('Usage: fogd admin capacity');
  if (!state.capacity) throw new Error('Server does not support capacity reporting; upgrade the controller');
  console.log(JSON.stringify(state.capacity, null, 2));
}

async function adminSession(env = null) {
  env ||= await configEnv();
  if (!env.FOGD_ADMIN_PASSWORD) throw new Error('Set FOGD_ADMIN_PASSWORD');
  const headers = { Authorization: `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER || 'admin'}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` };
  return { env, headers, state: await api(env, '/v1/admin', { headers }) };
}

export async function prepareSnapshotRequest(env, app, input, surface = 'delivery') {
  if (!['delivery', 'dispatch'].includes(surface)) throw new Error('Invalid snapshot control surface');
  const { headers, state: { csrf } } = await adminSession(env);
  return api(env, `/v1/apps/${encodeURIComponent(app)}/${surface}/snapshot`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Fogd-CSRF': csrf }, body: JSON.stringify(input) });
}

export async function adminAcknowledgeRecovery(...args) { return acknowledgeRecovery('delivery', ...args); }

async function acknowledgeRecovery(surface, app, deployment, digest, recovery, review, accept, ...extra) {
  const command = surface === 'dispatch' ? 'dispatch APP recover' : 'recover APP';
  if (!app || !deployment || !/^[a-f0-9]{64}$/.test(digest || '') || !recovery || !/^[a-f0-9]{64}$/.test(review || '') || accept !== '--accept-possible-loss' || extra.length) throw new Error(`Usage: fogd admin ${command} ID SHA RECOVERY_ID REVIEW_SHA --accept-possible-loss`);
  const { env, headers, state } = await adminSession();
  const result = await api(env, `/v1/apps/${encodeURIComponent(app)}/${surface}/acknowledge-recovery`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Fogd-CSRF': state.csrf }, body: JSON.stringify({ deployment, digest, recovery, review, acceptPossibleLoss: true }) });
  console.log(JSON.stringify(result, null, 2));
}

export async function adminDelivery(app, action = 'status', deployment, digest) { return adminBackground('delivery', app, action, deployment, digest); }
export async function adminDispatch(app, action = 'status', ...args) {
  if (action === 'recover') return acknowledgeRecovery('dispatch', app, ...args);
  if (args.length > 2) throw new Error('Too many dispatch arguments');
  return adminBackground('dispatch', app, action, ...args);
}

async function adminBackground(surface, app, action, deployment, digest) {
  if (!app || !['status', 'observe', 'pause', 'resume'].includes(action)) throw new Error(`Usage: fogd admin ${surface} APP [status|observe|pause|resume ID SHA]`);
  if (action === 'resume' ? !deployment || !/^[a-f0-9]{64}$/.test(digest || '') : deployment !== undefined || digest !== undefined) throw new Error(`Resume requires the inspected deployment ID and digest; other ${surface} actions take no extra arguments`);
  const { env, headers, state } = await adminSession();
  const path = `/v1/apps/${encodeURIComponent(app)}/${surface}`;
  const options = action === 'status' ? { headers } : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Fogd-CSRF': state.csrf }, body: JSON.stringify({ deployment, digest }) };
  const result = await api(env, action === 'status' ? path : `${path}/${action}`, options);
  console.log(JSON.stringify(result, null, 2));
}


export async function adminRepair(id, digest, heldId, heldDigest, secretRevision) {
  if (!id || !digest || !heldId || !heldDigest) throw new Error('Usage: fogd admin repair NEW_ID NEW_SHA HELD_ID HELD_SHA [REV]');
  const { env, headers, state } = await adminSession();
  await decideDeployment(env, headers, state, 'approve', id, digest, secretRevision, { deployment: heldId, digest: heldDigest });
}
