import { mkdir } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { hash, privateJSON, exists } from '../build-cache/paths.mjs';
import { bindHostDirectory, checkHostDirectory, syncHostDirectory } from '../runtime/host-directory.mjs';
import { captureProcess } from '../logs/capture.mjs';
import { readPrivatePreviewFile } from './private-record.mjs';
import { readPreviewOwnerControl, previewOwnerDocker, previewOwnerEnvironment, checkPreviewOwnerControlLocation } from './owner-control.mjs';
import { previewLogObservation, samePreviewLogScope } from './log-observation.mjs';

function refuse() {
  const error = new Error('Preview logs refused; retain private output and original owner/allocation records');
  error.code = 'PREVIEW_LOGS_REFUSED'; throw error;
}
const within = (path, parent) => path === parent || path.startsWith(parent + sep);
async function outputPath(directory, control, output) {
  const path = await checkPreviewOwnerControlLocation({ root: control.root, directory }, { directory: output, dockerContext: control.dockerContext });
  for (const [parent, marker] of [[dirname(control.root), 'profile.json'], [dirname(directory), 'request.complete.json']]) {
    if (await exists(join(parent, marker)) && within(path, parent)) refuse();
  }
  return path;
}
async function privateCaptureFiles(bound, result) {
  const files = {};
  for (const stream of ['stdout', 'stderr']) {
    const name = stream + '.log', bytes = await readPrivatePreviewFile(bound, name, 1048576);
    if (bytes.length !== result[stream + 'Bytes']) refuse();
    files[stream] = { path: name, bytes: bytes.length, sha256: hash(bytes) };
  }
  return files;
}

function captureReport({ control, allocationId, role, container, tail, capturedAt, result, files, before, after }) {
  const matched = after !== null && samePreviewLogScope(before, after);
  return { schema: 1, kind: 'fogd-preview-private-logs', app: control.envelope.grant.source.app, preview: control.envelope.grant.preview,
    submission: control.envelope.grant.source.submission, digest: control.envelope.grant.source.digest, allocationId, role, container,
    capturedAt, finishedAt: new Date().toISOString(), source: 'docker-container-logs',
    binding: { ownerControlSha256: before.controlSha256, allocationSha256: before.allocation, inventorySha256: before.inventorySha256, engineId: control.plan.request.engineId, image: control.expectedImage },
    disclosure: 'unredacted-owner-only', tail,
    scope: matched ? 'matched-at-boundaries' : 'unconfirmed', before: { state: before.roles[role].state, pendingOperation: before.pendingOperation },
    after: after ? { state: after.roles[role].state, pendingOperation: after.pendingOperation } : null,
    status: !matched ? 'scope-unconfirmed' : result.status === 'captured' ? 'captured' : 'partial', capture: { ...result, files },
    health: 'not-assessed', resourcesRetained: true, executionAuthorized: false };
}

export async function capturePreviewLogs({ directory, allocationId, role, output, tail = 2000, run, capture = captureProcess }) {
  try {
    if (!Number.isInteger(tail) || tail < 1 || tail > 10000 || typeof capture !== 'function') refuse();
    const owner = await bindHostDirectory(directory), control = await readPreviewOwnerControl(owner.canonical, allocationId);
    if (typeof role !== 'string' || !Object.hasOwn(control.plan.services, role)) refuse();
    const path = await outputPath(owner.canonical, control, output), parent = await bindHostDirectory(dirname(path));
    run ??= previewOwnerDocker(control.dockerContext);
    const observe = previewLogObservation(owner.canonical, control, run), before = await observe();
    await checkHostDirectory(parent); await mkdir(path, { mode: 0o700 }); await syncHostDirectory(parent);
    const bound = await bindHostDirectory(path), container = before.roles[role].id;
    const capturedAt = new Date().toISOString(), result = await capture('docker', ['--context', control.dockerContext, 'logs', '--timestamps', '--tail', String(tail), container],
      { stdout: join(path, 'stdout.log'), stderr: join(path, 'stderr.log'), env: previewOwnerEnvironment(), timeoutMs: 15000, maxBytes: 1048576, graceMs: 1000 });
    const files = await privateCaptureFiles(bound, result); let after = null;
    try { after = await observe(); } catch { /* Scope is unknown; keep private files without retrying collection. */ }
    const report = captureReport({ control, allocationId, role, container, tail, capturedAt, result, files, before, after });
    await checkHostDirectory(bound); await privateJSON(join(path, 'capture.json'), report); await syncHostDirectory(bound);
    return { ...report, output: path };
  } catch { refuse(); }
}
