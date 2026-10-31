import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { previewOwnerFixture } from './preview-owner.mjs';
import { createPreviewOwnerBrowser } from '../../src/preview/owner-browser.mjs';

export async function previewOwnerBrowserFixture(t, { running = true, transport } = {}) {
  const x = await previewOwnerFixture(t, { running }), directory = x.ownerDirectory;
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
