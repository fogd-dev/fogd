import { MAX_UPLOAD } from '@fogd/runtime/manifest';
import { hash, jsonBytes, digest } from '../build-cache/paths.mjs';
import { authorizePreviewExecution } from './execution.mjs';
import { executionKeys, refuseExecution } from './execution-shape.mjs';
import { validatePreviewArtifact, validatePreviewSecrets } from './control-input.mjs';
import { previewTLS } from './ingress.mjs';

export const previewInputPackageLimit = 2 * MAX_UPLOAD + 1024 ** 2;
export const previewInputGroups = ['controller-trust', 'controller-input', 'gateway-trust', 'gateway-input', 'ingress-trust', 'ingress-input'];
const fingerprintNames = ['authorityPublicKey', 'artifact', 'previewSecrets', 'storagePassword', 'gatewayToken', 'viewerAccessKey', 'gatewayTLS', 'ingressTLS'];
const checkHash = (value, expected) => { if (hash(value) !== expected) refuseExecution(); };
function validateAuthority(authority) {
  executionKeys(authority, ['publicKey', 'expectedGrantSha256', 'preparationSha256', 'target', 'fingerprints']);
  executionKeys(authority.fingerprints, fingerprintNames);
  if (!Object.values(authority.fingerprints).every(digest)) refuseExecution();
  checkHash(authority.publicKey, authority.fingerprints.authorityPublicKey);
}
function validateService(role, config, grant, fingerprints) {
  executionKeys(config, role === 'gateway' ? ['tls', 'gatewayToken'] : ['tls', 'accessKey', 'upstreamCA']);
  executionKeys(config.tls, ['cert', 'key']);
  const tls = previewTLS(config.tls, new URL(grant.target.origin).hostname);
  if (Date.parse(tls.expires) < Date.parse(grant.expiresAt)) refuseExecution();
  checkHash(jsonBytes(config.tls), fingerprints[role === 'gateway' ? 'gatewayTLS' : 'ingressTLS']);
  const key = role === 'gateway' ? config.gatewayToken : config.accessKey;
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) refuseExecution();
  checkHash(key, fingerprints[role === 'gateway' ? 'gatewayToken' : 'viewerAccessKey']);
}
function packageFiles(authority, bundle) {
  const { fingerprints, ...trust } = authority;
  const controller = { schema: 1, role: 'controller', ...trust, artifactSha256: fingerprints.artifact, secretsSha256: fingerprints.previewSecrets,
    storagePasswordSha256: fingerprints.storagePassword, gatewayTokenSha256: fingerprints.gatewayToken };
  const files = { 'controller-trust': { 'trust.json': jsonBytes(controller) },
    'controller-input': { 'execution.json': jsonBytes(bundle.envelope), 'artifact.json': jsonBytes(bundle.artifact), 'secrets.json': jsonBytes(bundle.secrets) } };
  for (const role of ['gateway', 'ingress']) {
    files[role + '-trust'] = { 'trust.json': jsonBytes({ schema: 1, role, ...trust, serviceSha256: hash(jsonBytes(bundle[role])) }) };
    files[role + '-input'] = { 'execution.json': jsonBytes(bundle.envelope), 'service.json': jsonBytes(bundle[role]) };
  }
  return files;
}

// Snapshot and validate actual bytes; artifact validation parses declarations but
// executes neither worker code nor SQL. Source vault values are never fetched.
export async function preparePreviewInputPackage(authority, input) {
  try {
    const authorityBytes = Buffer.from(jsonBytes(authority));
    if (authorityBytes.length > 32768) refuseExecution();
    authority = JSON.parse(authorityBytes);
    validateAuthority(authority);
    const bytes = Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(jsonBytes(input));
    if (bytes.length > previewInputPackageLimit) refuseExecution();
    const bundle = JSON.parse(bytes);
    if (!bytes.equals(Buffer.from(jsonBytes(bundle)))) refuseExecution();
    executionKeys(bundle, ['envelope', 'artifact', 'secrets', 'gateway', 'ingress']);
    const grant = authorizePreviewExecution(bundle.envelope, authority);
    checkHash(jsonBytes(bundle.artifact), authority.fingerprints.artifact); checkHash(jsonBytes(bundle.secrets), authority.fingerprints.previewSecrets);
    validatePreviewSecrets(grant, bundle.secrets);
    validateService('gateway', bundle.gateway, grant, authority.fingerprints); validateService('ingress', bundle.ingress, grant, authority.fingerprints);
    if (bundle.ingress.upstreamCA !== bundle.gateway.tls.cert) refuseExecution();
    await validatePreviewArtifact(grant, bundle.artifact);
    const files = packageFiles(authority, bundle), manifest = Object.fromEntries(Object.entries(files).map(([group, values]) => [group,
      Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { bytes: Buffer.byteLength(value), sha256: hash(value) }]))]));
    return { bytes, sha256: hash(bytes), files, manifest, grant };
  } catch { refuseExecution(); }
}
