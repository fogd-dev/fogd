import { runtimeFamily, assertRuntimeHost } from '../runtime/catalog.mjs';
import { assertTransferImageStore } from '../distribution/host.mjs';
import { docker } from '../recovery/docker.mjs';

const options = { timeoutMs: 15000, maxOutputBytes: 1024 * 1024 };
const finding = (id, status, message, nextStep) => ({ id, status, message, nextStep });

// Metadata only: no image execution, pulls, containers, mounts or host changes.
export async function inspectHost(family, run = docker) {
  const entry = runtimeFamily(family, 'enrolled');
  const findings = [finding('admission', entry.admission === 'qualified' ? 'supported' : 'unsupported',
    entry.admission === 'qualified' ? 'Family permits ordinary enrollment.' : 'Candidate family: ordinary enrollment is closed.',
    'Keep runtime admission gates in force; diagnosis does not enroll a runtime.')];
  let host;
  try {
    host = JSON.parse(await run(['info', '--format', '{{json .}}'], options));
    if (!host || typeof host.OSType !== 'string' || typeof host.Architecture !== 'string' || typeof host.Driver !== 'string') throw new Error();
    if (!Array.isArray(host.DriverStatus) || !host.DriverStatus.every(row => Array.isArray(row) && row.length === 2 && row.every(value => typeof value === 'string'))) throw new Error();
    findings.push(finding('docker', 'supported', 'Docker engine responded.', 'Use the same Docker context for subsequent commands.'));
  } catch {
    host = undefined;
    findings.push(finding('docker', 'unverified', 'Docker engine metadata is unavailable or unreadable.', 'Install Docker and check access to the selected context.'));
  }
  if (host) {
    findings.push(validate('architecture', () => assertRuntimeHost(host), 'Linux arm64 engine matches the runtime catalog.',
      'Engine does not match the supported runtime platform.', 'Use a Linux arm64 Docker engine; the client machine architecture is not the engine architecture.'));
    findings.push(validate('image-store', () => assertTransferImageStore(host), 'Classic overlay2 image store matches offline-transfer qualification.',
      'Image store is outside offline-transfer qualification.', 'Use a separately prepared classic overlay2 engine; do not change a store holding existing data.'));
  }
  await inspectCompose(findings, run);
  for (const [role, id] of [['runtime', entry.image], ['storage', entry.storageImage]]) {
    findings.push(await inspectImage(role, id, entry, run));
  }
  for (const [id, message, nextStep] of [
    ['program-integrity', 'Image programs and source inventory have not been executed or verified.', 'Startup still performs authoritative runtime verification.'],
    ['network', 'Installation ports, subnets and reachability have not been checked.', 'Check the intended installation configuration and network plan before startup.'],
    ['storage-space', 'Backing filesystem space and storage health have not been checked.', 'For an enrolled installation, use fogd storage space --installation PROJECT; free space is not a health guarantee.'],
    ['tls', 'Installation certificates and client trust have not been checked.', 'Follow the operator TLS procedure for the intended installation.'],
    ['application', 'Application declarations and build compatibility have not been checked.', 'Deployment negotiation and server-side artifact validation remain required.'],
  ]) findings.push(finding(id, 'unverified', message, nextStep));
  return { schema: 1, family: entry.id, scope: 'docker-host-metadata', readOnly: true,
    status: findings.some(item => item.status === 'unsupported') ? 'unsupported' : 'unverified',
    capacityReservation: 'none', findings };
}

function validate(id, check, success, failure, nextStep) {
  try { check(); return finding(id, 'supported', success, nextStep); }
  catch { return finding(id, 'unsupported', failure, nextStep); }
}

async function inspectCompose(findings, run) {
  try {
    const version = (await run(['compose', 'version', '--short'], options)).trim();
    const match = /^v?(\d+)\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.exec(version);
    findings.push(finding('compose', match ? (Number(match[1]) >= 2 ? 'supported' : 'unsupported') : 'unverified',
      match ? 'Docker Compose version was observed; installation compatibility still requires startup validation.' : 'Docker Compose returned an unrecognized version.',
      'Use Docker Compose v2 or later.'));
  } catch {
    findings.push(finding('compose', 'unverified', 'Docker Compose could not be queried.', 'Install the Docker Compose plugin and check docker compose version.'));
  }
}

async function inspectImage(role, id, entry, run) {
  const nextStep = 'Acquire and verify the exact family through the offline runtime transfer procedure; no image was pulled.';
  try {
    const images = JSON.parse(await run(['image', 'inspect', id], options));
    if (!Array.isArray(images) || images.length !== 1 || images[0]?.Id !== id ||
      typeof images[0].Os !== 'string' || typeof images[0].Architecture !== 'string') throw new Error();
    const matches = images[0].Os === entry.os && images[0].Architecture === entry.architecture;
    return finding(`${role}-image`, matches ? 'supported' : 'unsupported',
      matches ? 'Exact cached image ID and platform are present; program integrity remains unverified.' : 'Cached image platform differs from the selected family.', nextStep);
  } catch {
    return finding(`${role}-image`, 'unverified', 'Exact cached image is absent, inaccessible or unreadable.', nextStep);
  }
}
