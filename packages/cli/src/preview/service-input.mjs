import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { authorizePreviewExecution } from './execution.mjs';
import { executionKeys, refuseExecution } from './execution-shape.mjs';
import { previewInputJSON, previewInputDirectory } from './input-files.mjs';
import { previewTLS } from './ingress.mjs';

// Trust is installed independently by the host. Each service gets its own
// read-only credentials/configuration, never another role's secrets or vault.
export async function readPreviewService(role, { trustDirectory, inputDirectory, expiresAt }) {
  try {
    if (!['gateway', 'ingress'].includes(role)) refuseExecution();
    await previewInputDirectory(trustDirectory); await previewInputDirectory(inputDirectory);
    const trust = await previewInputJSON(join(trustDirectory, 'trust.json'), 16384);
    executionKeys(trust, ['schema', 'role', 'publicKey', 'expectedGrantSha256', 'preparationSha256', 'target', 'serviceSha256']);
    if (trust.schema !== 1 || trust.role !== role || !/^[a-f0-9]{64}$/.test(trust.serviceSha256 || '')) refuseExecution();
    const envelope = await previewInputJSON(join(inputDirectory, 'execution.json'), 16384);
    const grant = authorizePreviewExecution(envelope, trust);
    if (expiresAt !== grant.expiresAt) refuseExecution();
    const config = await previewInputJSON(join(inputDirectory, 'service.json'), 131072, trust.serviceSha256);
    executionKeys(config, role === 'gateway' ? ['tls', 'gatewayToken'] : ['tls', 'accessKey', 'upstreamCA']);
    executionKeys(config.tls, ['cert', 'key']);
    const hostname = new URL(grant.target.origin).hostname;
    if (!hostname.startsWith(grant.source.app + '.')) refuseExecution();
    const tls = previewTLS(config.tls, hostname);
    if (Date.parse(tls.expires) < Date.parse(grant.expiresAt)) refuseExecution();
    const key = role === 'gateway' ? config.gatewayToken : config.accessKey;
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) refuseExecution();
    if (role === 'ingress') new X509Certificate(config.upstreamCA);
    return { role, grant, config };
  } catch { refuseExecution(); }
}
