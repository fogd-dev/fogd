import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { recoveryOptions } from '../runtime/recovery-options.mjs';
import { readAppArchivePlan, readAppArchiveRestorationPlan } from '../runtime/app-archive-plan.mjs';
import { archiveDurableInstallation, restoreArchivedInstallation } from './durable-restore.mjs';
import { appArchiveReview } from './app-archive-review.mjs';

const usage = 'Usage: fogd archive [restore] [plan] BUNDLE [RETAINED_BUNDLE] --runtime FAMILY --expected-identity SHA256 --project NEW [--app NAME --digest SHA256 | --archive UUID --archive-identity SHA256 --retained-identity SHA256 --slot SLOT] [--network-plan FILE] [--output DIR --expected-plan SHA256]';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const stringOptions = ['runtime', 'expected-identity', 'retained-identity', 'network-plan', 'expected-plan', 'app', 'digest', 'project', 'output', 'archive', 'archive-identity', 'slot'];
function outputArguments(values, preview) {
  if (preview ? values.output !== undefined || values['expected-plan'] !== undefined : !values.output || !hex(values['expected-plan'])) throw new Error(usage);
}
function archiveRequest(restoring, values) {
  if (!restoring) {
    if (!hex(values.digest)) throw new Error(usage);
    return { app: values.app, digest: values.digest };
  }
  if (!hex(values['archive-identity']) || !hex(values['retained-identity']) || !/^slot-[12]$/.test(values.slot) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(values.archive)) throw new Error(usage);
  return { archive: values.archive, expectedIdentity: values['archive-identity'], slot: values.slot };
}
function input(args) {
  const restoring = args[0] === 'restore'; if (restoring) args = args.slice(1);
  const preview = args[0] === 'plan'; if (preview) args = args.slice(1);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(stringOptions.map(name => [name, { type: 'string' }])) });
  const required = restoring ? ['archive', 'archive-identity', 'retained-identity', 'slot'] : ['app', 'digest'];
  const excluded = restoring ? ['app', 'digest'] : ['archive', 'archive-identity', 'retained-identity', 'slot'];
  if (positionals.length !== (restoring ? 2 : 1) || !values.runtime || !values.project || !hex(values['expected-identity']) ||
    required.some(key => !values[key]) || excluded.some(key => values[key] !== undefined)) throw new Error(usage);
  outputArguments(values, preview);
  return { restoring, preview, values, positionals };
}

// IO overrides are trusted composition for qualification, never CLI arguments.
export async function archiveCommand(args, options = {}) {
  const io = { selection: recoveryOptions, archivePlan: readAppArchivePlan, restorePlan: readAppArchiveRestorationPlan,
    archive: archiveDurableInstallation, restore: restoreArchivedInstallation, print: value => console.log(JSON.stringify(value, null, 2)), ...options };
  const { restoring, preview, values, positionals } = input(args);
  const request = archiveRequest(restoring, values);
  const selection = await io.selection(values);
  if (restoring) selection.retainedIdentity = values['retained-identity'];
  const directory = resolve(positionals[0]), retained = restoring ? resolve(positionals[1]) : null;
  if (preview) {
    const plan = restoring ? await io.restorePlan(directory, retained, values.project, selection, request)
      : await io.archivePlan(directory, values.project, selection, request);
    io.print(appArchiveReview(plan)); return;
  }
  request.expectedPlan = values['expected-plan'];
  const result = restoring ? await io.restore(directory, retained, values.project, resolve(values.output), selection, request)
    : await io.archive(directory, values.project, resolve(values.output), selection, request);
  io.print({ schema: 1, operation: restoring ? 'restore-archive' : 'archive', project: result.config.name,
    archive: result.archive, application: restoring ? 'archive-recovery-pending' : 'archived',
    services: 'stopped', http: 'withheld', background: 'held-when-declared', output: result.directory,
    retention: 'source-volumes-and-snapshots-retained', execution: 'requires-explicit-start-and-recovery-approval' });
}
