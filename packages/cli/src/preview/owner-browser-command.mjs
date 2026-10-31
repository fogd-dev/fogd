import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { uuid } from '../build-cache/paths.mjs';
import { createPreviewOwnerBrowser } from './owner-browser.mjs';
import { previewForegroundOutput } from './foreground-output.mjs';

// Closing the owner UI never requests an app stop. An already authorized stop
// remains owned until completion, even when its browser connection disappears.
export async function runPreviewOwnerBrowser(input, publish) {
  const cancellation = new AbortController(), cancel = () => cancellation.abort(), output = publish ? null : previewForegroundOutput(cancel);
  publish ??= value => output.write(value);
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let active;
  try {
    active = await createPreviewOwnerBrowser(input);
    if (!cancellation.signal.aborted) {
      await publish({ event: 'owner-browser-ready', origin: active.origin, accessFile: active.accessFile, allocationId: active.allocationId, capability: active.capability });
      await Promise.race([active.completion, new Promise(resolve => {
        if (cancellation.signal.aborted) resolve(); else cancellation.signal.addEventListener('abort', resolve, { once: true });
      })]);
    }
    await active.close();
    if (output?.failure) throw output.failure;
    await publish({ event: 'owner-browser-closed', allocationId: active.allocationId, previewStopRequested: false });
  } finally {
    await active?.close(); output?.close();
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
}
export async function previewOwnerBrowserCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { control: { type: 'string' } } });
  if (positionals.length !== 1 || !uuid(positionals[0]) || !values.control) throw new Error('Usage: fogd preview manage ALLOCATION_UUID --control OWNER_DIRECTORY');
  return runPreviewOwnerBrowser({ directory: resolve(values.control), allocationId: positionals[0] });
}
