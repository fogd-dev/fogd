import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { installedPreviewFixture } from './installed-preview.mjs';
import { previewRuntimeFamily } from '../../src/preview/runtime-catalog.mjs';
import { startPreviewAllocation } from '../../src/preview/startup.mjs';
import { writePreviewOwnerControl } from '../../src/preview/owner-control.mjs';
import { createPreviewOwnerBrowser } from '../../src/preview/owner-browser.mjs';

export async function previewOwnerBrowserFixture(t, { running = true, transport } = {}) {
  const x = await installedPreviewFixture(t, undefined, { runtime: previewRuntimeFamily('celld-preview-http-v1-linux-arm64', { candidateEnrollment: true }) });
  if (running) await startPreviewAllocation(x.args);
  const directory = join(x.input.root, 'browser-owner');
  await writePreviewOwnerControl(x.args, { directory, dockerContext: 'owner-browser-fixture' });
  const run = transport ? (...args) => transport(x, ...args) : x.args.run;
  const ui = await createPreviewOwnerBrowser({ directory, allocationId: x.args.allocationId, run });
  t.after(async () => { await ui.close(); await rm(dirname(ui.accessFile), { recursive: true }); });
  const access = JSON.parse(await readFile(ui.accessFile));
  x.calls.length = 0; x.source.calls.length = 0;
  const request = (action, value = {}, extra = {}) => fetch(ui.origin + '/' + action, { method: 'POST',
    headers: { origin: ui.origin, authorization: 'Bearer ' + access.accessKey, 'content-type': 'application/json', ...extra.headers },
    body: JSON.stringify(value), ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'headers')) });
  return { ...x, ownerDirectory: directory, ui, access, request };
}
