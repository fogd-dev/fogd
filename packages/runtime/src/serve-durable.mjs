import { runDurableGateway } from './gateway-process.mjs';

try { process.exitCode = (await runDurableGateway()).code; }
catch {
  console.error('Durable gateway refused or failed startup; keep ingress stopped');
  process.exitCode = 1;
}
