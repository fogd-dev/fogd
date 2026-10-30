import { readPreviewService } from './service-input.mjs';
import { runPreviewGateway } from './gateway.mjs';
import { createPreviewIngress } from './ingress.mjs';

async function ingress(input, signal) {
  const { grant, config } = input;
  const service = createPreviewIngress({ ...config, origin: grant.target.origin, target: `https://${new URL(grant.target.origin).hostname}:8080`,
    expiresAt: grant.expiresAt, identity: { preview: grant.preview, app: grant.source.app, submission: grant.source.submission, digest: grant.source.digest } });
  const close = () => { void service.close(); };
  const closed = new Promise(resolve => service.server.once('close', resolve));
  const timer = setTimeout(close, Math.max(0, Date.parse(grant.expiresAt) - Date.now()));
  signal.addEventListener('abort', close, { once: true });
  try {
    if (signal.aborted) return;
    await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(8080, '0.0.0.0', resolve); });
    console.log(JSON.stringify({ previewIngress: 'ready', preview: grant.preview }));
    await closed;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', close); await service.close(); }
}

try {
  if (process.argv.length !== 3) throw new Error();
  const cancellation = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT']) process.on(name, () => cancellation.abort());
  const input = await readPreviewService(process.argv[2], { trustDirectory: '/run/fogd-preview-trust', inputDirectory: '/run/fogd-preview-service', expiresAt: process.env.FOGD_PREVIEW_EXPIRES_AT });
  if (input.role === 'gateway') {
    const result = await runPreviewGateway(input, cancellation.signal); console.log(JSON.stringify({ previewGateway: result }));
    if (!result.childExitConfirmed || !['expired', 'cancelled'].includes(result.outcome)) process.exit(1);
  } else await ingress(input, cancellation.signal);
} catch { console.error('Preview service refused; retain its resources and inspect the exact enrollment'); process.exit(1); }
