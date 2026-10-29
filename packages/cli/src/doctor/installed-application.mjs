import { observationInstallation } from '../observe/installation.mjs';
import { ObserverCleanupError } from '../observe/cleanup.mjs';
import { spaceInventory } from '../storage/inventory.mjs';
import { projectName } from '../recovery/docker.mjs';
import { inspectBuiltProject } from './application.mjs';
import { compareInstalledRelease } from './installation-comparison.mjs';
import { finding, reportStatus } from './report.mjs';

export async function diagnoseInstalledApplication(values) {
  const project = values['against-installation']; projectName(project);
  let installation, backing;
  try {
    installation = await observationInstallation(project);
    backing = await spaceInventory(installation.config);
  } catch { /* Missing or inconsistent installation observations stay unknown. */ }
  const report = await inspectBuiltProject(values.project, values.name, installation ? async () => ({ cronApps: true }) : undefined,
    release => installation && backing ? compare(installation, backing, release) : Promise.resolve({ finding: unavailable() }));
  if (installation) {
    report.capabilitySource = 'installed-policy';
    const policyFinding = finding('target-capabilities', 'supported',
      'Selected installation policy was verified locally; no controller was contacted.',
      'Owner inspection does not establish a deploy credential, running controller or admission reservation.');
    report.findings = report.findings.map(item => item.id === 'target-capabilities' ? policyFinding : item);
    report.findings = report.findings.filter(item => item.id !== 'cron-admission');
  }
  report.againstInstallation = project;
  report.status = reportStatus(report.findings);
  return report;
}

async function compare(installation, backing, release) {
  try {
    const comparison = await compareInstalledRelease(installation, backing, release);
    const messages = {
      compatible: `Recorded resource identities and applied migrations permit this candidate; ${comparison.r2Added} R2 additions and ${comparison.pendingMigrations} pending migrations.`,
      'resource-identity': 'The candidate removes or changes a retained resource identity.',
      'cron-transition': 'Adding or removing scheduled dispatch on this app is not qualified.',
      'migration-history': 'The candidate removes or changes an applied migration.',
      quarantined: 'The recorded application slot is quarantined.', retired: 'The application name is permanently retired.',
      'queue-admission': 'Queue application admission is disabled on the selected installation.',
      'cron-admission': 'Scheduled application admission is disabled on the selected installation.',
      state: 'Controller records are incomplete or could not be classified.',
    };
    return { comparison, finding: finding('resource-changes', comparison.status, messages[comparison.reason],
      'This is one read-only metadata observation, not SQL reconciliation, activation readiness or a writer fence. Submission and exact approval repeat authoritative checks.') };
  } catch (error) {
    if (error instanceof ObserverCleanupError) throw error;
    return { finding: unavailable() };
  }
}

function unavailable() {
  return finding('resource-changes', 'unverified', 'Selected installation records or compatibility helper could not be verified.',
    'Check the enrolled configuration, owned storage and verified cached image. No application or controller state was changed.');
}
