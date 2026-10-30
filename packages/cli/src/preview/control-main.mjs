import { Backend } from '../../../platform/src/backend.mjs';
import { readPreviewControl } from './control-input.mjs';
import { activatePreviewControl, previewControlServer } from './control.mjs';

// Paths are fixed by the checked host enrollment, never environment overrides.
try {
  const input = await readPreviewControl({ trustDirectory: '/run/fogd-preview-trust', inputDirectory: '/run/fogd-preview-input', env: process.env });
  const activated = await activatePreviewControl(input, { directory: '/var/lib/fogd', backend: new Backend(input.storage) });
  const server = previewControlServer(input, activated);
  const close = () => { server.closeAllConnections(); server.close(); };
  const expiry = setTimeout(close, Math.max(0, Date.parse(input.grant.expiresAt) - Date.now()));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { clearTimeout(expiry); close(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8083, '0.0.0.0', resolve); });
  console.log(JSON.stringify({ previewController: 'ready', preview: input.grant.preview, digest: input.grant.source.digest }));
} catch { console.error('Preview controller refused; retain its resources and inspect the exact enrollment'); process.exit(1); }
