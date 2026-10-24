import { parseArgs } from 'node:util';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { appName } from '@fogd/runtime/artifact';
import { projectName } from '../recovery/docker.mjs';
import { observationInstallation, readObservationState } from '../observe/installation.mjs';
import { observationSelection } from '../observe/model.mjs';
import { observationKey } from '../observe/fingerprint.mjs';
import { runObserver, ObserverCleanupError } from '../observe/runner.mjs';
import { checkGatewayScope, checkHost, sameGateway } from './scope.mjs';
import { applicationCheckReport } from './report.mjs';
import { validateCheckPath } from './worker.mjs';

// Bound the read itself even if an external writer grows the public CA file.
async function certificateBytes(file) {
  const buffer = Buffer.alloc(65537); let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
    if (!bytesRead) return buffer.subarray(0, length);
    length += bytesRead;
  }
  throw new Error('Application check CA is oversized');
}

async function certificate(path) {
  if (path === undefined) return null;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 65536) throw new Error('Application check CA must be a bounded regular PEM file');
    const bytes = await certificateBytes(file);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g) || [];
    if (!blocks.length || text.replace(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g, '').trim()) throw new Error('Application check CA accepts certificates only, without private keys');
    for (const block of blocks) new X509Certificate(block);
    return blocks.join('\n');
  } finally { await file.close(); }
}

export async function checkCommand(args, qualification = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { installation: { type: 'string' }, path: { type: 'string' }, ca: { type: 'string' } } });
  if (positionals.length !== 1 || !values.installation || !values.path) throw new Error('Usage: fogd check APP --installation PROJECT --path /health [--ca PEM_FILE]');
  const app = appName(positionals[0]), project = projectName(values.installation), path = validateCheckPath(values.path), ca = await certificate(values.ca);
  const installation = await observationInstallation(project, qualification), state = await readObservationState(installation);
  if (ca !== null && installation.config.services.workerd.environment.FOGD_TLS !== '1') throw new Error('A CA file requires a TLS installation');
  const selection = observationSelection(state, app, installation.policy), context = { installation: project, boundary: 'single-read', gateway: 'not-observed', sent: false, reason: selection.reason };
  const sample = !selection.reason ? await sampleApplication(installation, selection, { path, ca }, context) : null;
  console.log(JSON.stringify(applicationCheckReport(selection, { ...context, observedAt: new Date().toISOString() }, sample), null, 2));
}

async function sampleApplication(installation, selection, { path, ca }, context) {
  let sample;
  try {
    const scope = await checkGatewayScope(installation, selection.fleet), host = checkHost(installation, selection.app);
    const code = (await readFile(new URL('./worker.mjs', import.meta.url), 'utf8')) + '\nawait main();\n';
    context.sent = true;
    sample = await runObserver(installation, { network: scope.network, code, input: { address: scope.address, host, tls: scope.tls, path, ca }, timeoutMs: 15000 });
    context.gateway = sameGateway(scope, await checkGatewayScope(installation, selection.fleet)) ? 'matched-at-boundaries' : 'changed';
    if (context.gateway !== 'matched-at-boundaries') context.reason = 'gateway-process-unconfirmed';
  } catch (error) {
    if (error instanceof ObserverCleanupError) throw error;
    context.reason = context.sent ? 'gateway-process-unconfirmed' : 'gateway-scope-unconfirmed';
  }
  try { context.boundary = observationKey(await readObservationState(installation), selection.app) === selection.key ? 'matched-at-boundaries' : 'changed'; }
  catch { context.boundary = 'unavailable'; }
  if (context.boundary !== 'matched-at-boundaries') context.reason = 'controller-record-unconfirmed';
  return sample;
}
