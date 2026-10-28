export const finding = (id, status, message, nextStep) => ({ id, status, message, nextStep });
export const reportStatus = findings => findings.some(item => item.status === 'unsupported') ? 'unsupported' : 'unverified';

export function formatReport(report) {
  const subject = report.app ? `Application ${report.app}` : `Runtime ${report.family}`;
  return [`${subject}: ${report.status} (${report.scope})`,
    ...(report.declarations ? [`Declarations: ${Object.entries(report.declarations).map(([name, value]) => `${name}=${value}`).join(', ')}`] : []),
    ...(report.artifact ? [`Observed artifact: ${report.artifact.digest}; ${report.artifact.files} files, ${report.artifact.bytes} bytes, ${report.artifact.migrations} migrations.`] : []),
    ...report.findings.map(item => `[${item.status}] ${item.id}: ${item.message}\n  ${item.nextStep}`),
    'Read-only observation; no capacity reserved. Installation readiness is not established.'].join('\n');
}

export function printReport(report, json) {
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exitCode = report.status === 'unsupported' ? 1 : 2;
}
