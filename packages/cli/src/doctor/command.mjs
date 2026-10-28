import { parseArgs } from 'node:util';
import { inspectHost } from './host.mjs';

export async function doctorCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    runtime: { type: 'string' }, json: { type: 'boolean' },
  } });
  if (positionals.length || !values.runtime) throw new Error('Usage: fogd doctor --runtime FAMILY [--json]');
  const report = await inspectHost(values.runtime);
  console.log(values.json ? JSON.stringify(report, null, 2) : formatHostReport(report));
  process.exitCode = report.status === 'unsupported' ? 1 : 2;
}

export function formatHostReport(report) {
  return [`Runtime ${report.family}: ${report.status} (${report.scope})`,
    ...report.findings.map(item => `[${item.status}] ${item.id}: ${item.message}\n  ${item.nextStep}`),
    'Read-only observation; no capacity reserved. Installation readiness is not established.'].join('\n');
}
