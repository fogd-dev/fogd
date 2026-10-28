import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest, receiveArtifact, MAX_UPLOAD } from '@fogd/runtime/manifest';
import { artifactProject } from '../local.mjs';
import { appName, translateConfig, inside, regularFiles, stageArtifact } from '@fogd/runtime/artifact';
import { buildMetadata } from '@fogd/runtime/deployment';
import { readPrivateJSON, hash } from '../build-cache/paths.mjs';
import { finding, reportStatus } from './report.mjs';

export async function inspectApplicationFile(path, app, negotiate) {
  appName(app);
  let input;
  try { input = await readPrivateJSON(path, 1024 * 1024); }
  catch {
    return applicationReport(app, [finding('config-file', 'unverified', 'Configuration JSON is missing, unreadable, linked, or exceeds its size limit.',
      'Supply a regular JSON file of at most 1 MiB. JavaScript, TypeScript and JSONC configuration are not evaluated.')]);
  }
  let capabilities;
  if (negotiate) {
    try { capabilities = await negotiate(app); }
    catch { /* Report unavailable capabilities without transport or credential details. */ }
  }
  return { ...inspectApplicationConfig(input.value, app, capabilities, Boolean(negotiate)), configSha256: hash(input.bytes) };
}

export async function inspectBuiltProject(directory, app, negotiate) {
  appName(app);
  let project, settings, path;
  try {
    ({ project, settings } = await artifactProject(directory, app));
    path = join(inside(project, settings.buildOutput ?? 'dist/ssr'), 'wrangler.json');
  } catch {
    return { ...applicationReport(app, [finding('project-files', 'unverified', 'Project metadata could not be read.',
      'Check package.json and fogd.json; no build plugins were executed.')]), scope: 'application-build' };
  }
  let capabilities;
  const report = { ...await inspectApplicationFile(path, app, negotiate ? async name => {
    capabilities = await negotiate(name); return capabilities;
  } : undefined), scope: 'application-build' };
  if (!report.declarations) return report;
  const target = typeof capabilities?.cronApps === 'boolean' ? capabilities : { cronApps: true };
  let temporary;
  try { temporary = await mkdtemp(join(tmpdir(), 'fogd-doctor-build-')); }
  catch {
    replaceBuildFinding(report, finding('build-output', 'unverified', 'Private temporary staging is unavailable.',
      'Check that the operating system temporary directory exists and is writable. No project or client build-cache files were created.'));
    return report;
  }
  try {
    const staged = join(temporary, 'staged');
    const release = await stageArtifact({ projectDir: project, outputDir: staged, app,
      buildOutput: settings.buildOutput, migrationsDir: settings.migrationsDir, capabilities: target });
    const inventory = await artifactInventory(staged);
    const payload = await manifest(staged, release);
    const verified = await receiveArtifact(payload, join(temporary, 'verified'), target);
    const bytes = await readFile(join(staged, 'wrangler.json')), config = JSON.parse(bytes);
    report.declarations = { ...describeDeclarations(config, config), requiredSecrets: verified.requiredSecrets.length };
    report.configSha256 = hash(bytes);
    report.artifact = { digest: verified.digest, ...inventory, migrations: verified.migrations.length };
    replaceBuildFinding(report, finding('build-output', 'supported', 'Existing worker, assets and migration files pass shared staging and artifact validation.',
      'These are observed build bytes, not proof of current sources or native execution. Deployment builds and validates again.'));
  } catch (error) {
    replaceBuildFinding(report, buildFailure(error));
  } finally { await rm(temporary, { recursive: true, force: true }); }
  report.status = reportStatus(report.findings);
  return report;
}

export function inspectApplicationConfig(input, app, capabilities, online = false) {
  appName(app);
  const known = typeof capabilities?.cronApps === 'boolean';
  const findings = [finding('target-capabilities', known ? 'supported' : 'unverified',
    known ? 'Deployment capability negotiation completed for this app; this is not an admission reservation.' :
      (online ? 'Controller capabilities could not be verified.' : 'Offline check: installation capabilities were not queried.'),
    'Use --online with FOGD_SERVER and a scoped FOGD_DEPLOY_TOKEN; deployment negotiates again.')];
  let declarations = null;
  try {
    // Offline declaration checking includes cron, but never authorizes execution.
    const config = translateConfig(input, app, known ? capabilities : { cronApps: true });
    declarations = describeDeclarations(input, config);
    findings.push(finding('config-declarations', 'supported', 'Declarations pass the shared fogd configuration translator.',
      'This checks declarations only; retain artifact staging and server-side validation.'));
    if (declarations.cronExpressions) findings.push(finding('cron-admission', known ? 'supported' : 'unverified',
      known ? 'The target advertised cron admission for this app.' : 'Cron declarations were checked; target admission remains unverified.',
      'Keep scheduled work closed unless the actual installation permits it.'));
  } catch (error) {
    findings.push(finding('config-declarations', 'unsupported', configFailure(error),
      'Review supported configuration in the compatibility guide and regenerate JSON with the application toolchain.'));
  }
  for (const [id, message, nextStep] of [
    ['build-output', 'Worker modules, assets and SQL migration files have not been inspected.', 'Use existing generated JSON when available; a source declaration does not establish the generated build. This check runs no build plugins.'],
    ['resource-changes', 'Changes against the active release and migration history have not been compared.', 'The controller still checks resource evolution during submission and exact approval.'],
    ['secret-values', 'Required secret values and operator revisions have not been checked.', 'Have the operator configure private values and approve the exact revision.'],
    ['runtime-behavior', 'Native execution, cron expression grammar, health and available capacity have not been tested.', 'Run the supported deployment and operator acceptance workflow; no capacity has been reserved.'],
  ]) findings.push(finding(id, 'unverified', message, nextStep));
  return { ...applicationReport(app, findings, declarations), capabilitySource: known ? 'controller' : (online ? 'unavailable' : 'offline') };
}

function describeDeclarations(input, config) {
  return { d1: config.d1_databases.length, r2: config.r2_buckets.length,
    durableObjects: config.durable_objects.bindings?.length || 0, queueProducers: config.queues?.producers.length || 0,
    queueConsumers: config.queues?.consumers.length || 0, cronExpressions: config.triggers?.crons.length || 0,
    assets: Boolean(config.assets), requiredSecrets: buildMetadata(input).requiredSecrets.length };
}

function applicationReport(app, findings, declarations = null) {
  return { schema: 1, app, scope: 'application-config', readOnly: true, status: reportStatus(findings),
    capacityReservation: 'none', declarations, findings };
}

function configFailure(error) {
  const messages = [
    ['Unsupported binding/config: triggers', 'Scheduled applications are not admitted by this controller.'],
    ['Unsupported binding/config:', 'Configuration requests a binding or setting unsupported by fogd.'],
    ['Unsupported compatibility flag:', 'Configuration requests an unsupported compatibility flag.'],
    ['Combined cron and queue', 'Combined cron and queue activation is not qualified.'],
    ['v0 supports one D1', 'Only one D1 database per app is supported.'],
    ['Cross-script Durable Objects', 'Cross-script Durable Objects are not supported.'],
    ['Duplicate binding:', 'Resource and variable binding names must be distinct.'],
  ];
  return messages.find(([prefix]) => error?.message?.startsWith(prefix))?.[1] ||
    'Configuration declarations are invalid or outside the supported fogd profile; private input details are omitted.';
}

function replaceBuildFinding(report, value) {
  report.findings = report.findings.map(item => item.id === 'build-output' ? value : item);
}

function buildFailure(error) {
  const messages = [
    ['celld requires a single JavaScript module', 'The build must contain one JavaScript worker module.'],
    ['Worker main must identify', 'The configured worker entry is missing or invalid.'],
    ['Migration order must have', 'SQL migration filenames must have strictly increasing numeric prefixes.'],
    ['Symlinks are not allowed', 'Build inputs include a symbolic link; artifact files must be regular files.'],
    ['Path escapes project', 'A configured build or asset path leaves the project directory.'],
    ['Artifact exceeds the receiver byte limit', 'The staged artifact exceeds the receiver byte limit.'],
  ];
  return finding('build-output', ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? 'unverified' : 'unsupported',
    messages.find(([prefix]) => error.message?.startsWith(prefix))?.[1] ||
      'Existing build files are missing, unreadable or outside the supported artifact profile; private details are omitted.',
    'Regenerate a complete fogd-compatible build and check worker modules, assets and ordered SQL migrations. This command never builds or uploads.');
}

async function artifactInventory(directory) {
  const files = (await regularFiles(directory)).filter(path => path !== 'fogd-release.json');
  let bytes = 0;
  for (const path of files) {
    bytes += (await stat(join(directory, path))).size;
    if (bytes > MAX_UPLOAD) throw new Error('Artifact exceeds the receiver byte limit');
  }
  return { files: files.length, bytes };
}
