import { join } from 'node:path';
import { installedPreviewFixture } from './installed-preview.mjs';
import { previewRuntimeFamily } from '../../src/preview/runtime-catalog.mjs';
import { startPreviewAllocation } from '../../src/preview/startup.mjs';
import { writePreviewOwnerControl } from '../../src/preview/owner-control.mjs';

export async function previewOwnerFixture(t, { running = true } = {}) {
  const x = await installedPreviewFixture(t, undefined, { runtime: previewRuntimeFamily('celld-preview-http-v1-linux-arm64', { candidateEnrollment: true }) });
  if (running) await startPreviewAllocation(x.args);
  const ownerDirectory = join(x.input.root, 'owner-control');
  await writePreviewOwnerControl(x.args, { directory: ownerDirectory, dockerContext: 'owner-browser-fixture' });
  x.calls.length = 0; x.source.calls.length = 0;
  return { ...x, ownerDirectory };
}
