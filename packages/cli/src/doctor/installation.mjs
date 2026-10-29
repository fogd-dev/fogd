import { observationInstallation } from '../observe/installation.mjs';
import { ObserverCleanupError } from '../observe/cleanup.mjs';
import { inspectDurableInstallation } from '../runtime/durable-inventory.mjs';
import { projectName } from '../recovery/docker.mjs';
import { spaceInventory } from '../storage/inventory.mjs';
import { storageSpace } from '../storage/command.mjs';
import { inspectHost } from './host.mjs';
import { tlsEndpoint, inspectClientTrust } from './tls-endpoint.mjs';
import { inspectInstallationTLS } from './installation-tls.mjs';
import { installationDirectory } from '../runtime/installation-state.mjs';
import { installationLifecycleFinding } from './installation-lifecycle.mjs';
import { finding, reportStatus } from './report.mjs';

export async function inspectInstallation(project, { server, online = false } = {}) {
  const endpoint = server === undefined ? null : tlsEndpoint(server);
  projectName(project);
  let installation;
  try { installation = await observationInstallation(project); }
  catch {
    return installationReport(project, [finding('installation-policy', 'unverified', 'Enrolled configuration, startup fence or independently installed runtime policy could not be verified.',
      'Select the retained installation and Docker context. Keep incomplete recovery or enrollment stopped; this command does not repair it.')]);
  }
  const host = await inspectHost(installation.entry.id), findings = host.findings.filter(item => !['program-integrity', 'network', 'storage-space', 'tls'].includes(item.id));
  for (const item of findings) if (['runtime-image', 'storage-image'].includes(item.id) && item.status === 'supported') item.message = 'Exact cached image ID and platform match the independently verified installation family.';
  findings.push(finding('installation-policy', 'supported', 'Enrolled configuration, cached runtime programs and independent policy match.', 'Startup and recovery still perform their authoritative checks.'));
  findings.push(await installationLifecycleFinding(installationDirectory(project)));
  const inventory = await installationInventory(installation, findings);
  const storage = await installationStorage(project, findings);
  await installationTLS(installation, inventory, storage, findings, endpoint, online);
  return { ...installationReport(project, findings), family: installation.entry.id, ...(inventory ? { inventory } : {}), ...(storage ? { storage } : {}) };
}

async function installationInventory(installation, findings) {
  if (installation.entry.routing !== 'durable') {
    findings.push(finding('installation-inventory', 'unverified', 'Detailed network and listener inventory is available for the durable-routing family.', 'Use --runtime for legacy host metadata; retain startup validation.'));
    return null;
  }
  try {
    const inventory = await inspectDurableInstallation(installation.config, installation.policy);
    findings.push(finding('network-and-ports', 'supported', 'Owned Docker networks, subnets, attachments and published-port declarations match the sealed containers.', 'Host listeners, external routes, firewalls and client reachability remain unverified. No port was bound or reserved.'));
    return { identity: inventory.identity, services: Object.keys(inventory.services).length,
      running: Object.values(inventory.services).filter(service => service.running).length,
      listeners: ['controller', 'workerd'].flatMap(service => (installation.config.services[service].ports || []).map(port => ({ service, host: port.host_ip, port: Number(port.published), protocol: port.protocol }))),
      networks: Object.keys(installation.config.networks).length };
  } catch {
    findings.push(finding('network-and-ports', 'unverified', 'Docker installation inventory is missing, changed, inaccessible or inconsistent with its sealed configuration.', 'Inspect retained containers, networks and volume ownership before startup; raw Docker diagnostics are omitted.'));
    return null;
  }
}

async function installationStorage(project, findings) {
  try {
    const space = await storageSpace(project);
    findings.push(finding('storage-space', space.status === 'observed' ? 'supported' : 'unsupported',
      space.status === 'observed' ? 'Owned volume backing filesystems were sampled at matching inventory boundaries.' : 'One or more enrolled data volumes are missing.',
      'Free space does not establish storage health, available application capacity or a reservation. Retain missing-volume recovery inputs.'));
    return { status: space.status, filesystems: space.filesystems, storageHealth: 'not-assessed', capacityReservation: 'none' };
  } catch (error) {
    if (error instanceof ObserverCleanupError) throw error;
    findings.push(finding('storage-space', 'unverified', 'Owned backing storage could not be sampled consistently.', 'Check volume ownership and local backing storage; no missing named volume was created.'));
    return null;
  }
}

async function installationTLS(installation, inventory, storage, findings, endpoint, online) {
  findings.push(finding('tls-hostname', 'unverified', 'Installed certificate hostname coverage has not been verified.', 'Supply --server https://HOST:PORT to inspect hostname coverage without a network connection.'));
  findings.push(finding('tls-client-trust', 'unverified', 'The current client has not verified an endpoint TLS handshake.', 'Add --server https://HOST:PORT --online for an explicit TLS-only connection using current Node trust.'));
  if (!inventory || storage?.status !== 'observed') {
    findings.push(finding('tls-keypair', 'unverified', 'TLS bytes were not read because installation inventory or storage ownership remains unverified.', 'Resolve the installation inventory before inspecting its TLS keypair.'));
    return;
  }
  try {
    const backing = await spaceInventory(installation.config);
    const observation = await inspectInstallationTLS(installation, backing, undefined, endpoint?.hostname);
    if (endpoint) {
      findings[findings.findIndex(item => item.id === 'tls-hostname')] = finding('tls-hostname', observation.hostnameMatches ? 'supported' : 'unsupported',
        observation.hostnameMatches ? 'The installed certificate covers the requested endpoint hostname.' : 'The installed certificate does not cover the requested endpoint hostname.',
        'Use a certificate covering this hostname or select the intended endpoint. Chain trust and reachability are separate findings; no certificate was changed.');
      if (online && observation.hostnameMatches) findings[findings.findIndex(item => item.id === 'tls-client-trust')] = await inspectClientTrust(endpoint, observation.fingerprint);
    }
    findings.push(finding('tls-keypair', 'supported', 'Installed TLS certificate and private key match and are currently valid.', 'This validates installed bytes; separate hostname and client-trust findings describe endpoint observations. No trust was installed.'));
  } catch (error) {
    if (error instanceof ObserverCleanupError) throw error;
    findings.push(finding('tls-keypair', 'unverified', 'Installed TLS keypair is missing, unreadable, invalid or no longer current.', 'Use the documented stopped TLS import procedure; this check does not change certificates or print private bytes.'));
  }
}

function installationReport(installation, findings) {
  return { schema: 1, installation, scope: 'docker-installation-observation', readOnly: true, status: reportStatus(findings), capacityReservation: 'none', findings };
}
