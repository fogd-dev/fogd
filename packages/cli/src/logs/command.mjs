import { parseArgs, isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { appName } from '@fogd/runtime/artifact';
import { projectName } from '../recovery/docker.mjs';
import { writeJson } from '../recovery/bundle.mjs';
import { observationInstallation, readObservationState } from '../observe/installation.mjs';
import { observationKey } from '../observe/fingerprint.mjs';
import { ObserverCleanupError } from '../observe/runner.mjs';
import { logSelection } from './selection.mjs';
import { logScope, sameLogScope } from './scope.mjs';
import { logOwner } from './owner.mjs';
import { privateLogOutput } from './output.mjs';
import { captureProcess } from './capture.mjs';

export async function logsCommand(args, qualification = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { installation: { type: 'string' }, output: { type: 'string' }, tail: { type: 'string', default: '2000' } } });
  if (positionals.length !== 1 || !values.installation || !values.output) throw new Error('Usage: fogd logs APP --installation PROJECT --output NEW_DIRECTORY [--tail COUNT]');
  if (!/^[1-9][0-9]{0,4}$/.test(values.tail) || Number(values.tail) > 10000) throw new Error('Log tail must be between 1 and 10000 lines');
  const app = appName(positionals[0]), project = projectName(values.installation), installation = await observationInstallation(project, qualification);
  const selection = logSelection(await readObservationState(installation), app, installation.policy);
  const before = await logScope(installation, selection), owner = await logOwner(installation, selection);
  if (!owner.matched) throw new Error('Replica log ownership is unconfirmed; no logs were collected');
  const output = await privateLogOutput(values.output);
  const captures = await collect(before, output, values.tail), scope = await finishScope(installation, selection, before, owner);
  const status = captureStatus(scope, captures);
  const report = { schema: 1, app, installation: project, capturedAt: new Date().toISOString(), source: 'private-replica-process-capture', disclosure: 'unredacted-owner-only',
    recorded: selection.recorded, scope, status, captures };
  try { await writeJson(join(output, 'capture.json'), report); }
  catch { throw new Error('Private log files were retained but the capture summary could not be saved'); }
  console.log(JSON.stringify({ ...report, output }, null, 2));
  if (status !== 'captured') process.exitCode = 1;
}

async function collect(scope, output, tail) {
  const captures = [];
  for (const replica of scope.replicas) {
    const files = { stdout: `${replica.node}.stdout.log`, stderr: `${replica.node}.stderr.log` };
    const result = await captureProcess('docker', ['logs', '--timestamps', '--tail', tail, replica.id],
      { stdout: join(output, files.stdout), stderr: join(output, files.stderr) });
    captures.push({ node: replica.node, container: replica.id, files, ...result });
  }
  return captures;
}

function captureStatus(scope, captures) {
  if (Object.values(scope).some(value => value !== 'matched-at-boundaries')) return 'scope-unconfirmed';
  return captures.every(value => value.status === 'captured') ? 'captured' : 'partial';
}

async function finishScope(installation, selection, before, owner) {
  const result = { controllerRecord: 'unavailable', replicas: 'unavailable', owner: 'unconfirmed' };
  try { result.controllerRecord = observationKey(await readObservationState(installation), selection.app) === selection.key ? 'matched-at-boundaries' : 'changed'; }
  catch { /* Private metadata diagnostics remain local to the reader. */ }
  try { result.replicas = sameLogScope(before, await logScope(installation, selection)) ? 'matched-at-boundaries' : 'changed'; }
  catch { /* Unknown container scope cannot confirm a capture. */ }
  try {
    const after = await logOwner(installation, selection);
    if (after.matched && isDeepStrictEqual(owner.storage, after.storage)) result.owner = 'matched-at-boundaries';
  } catch (error) { if (error instanceof ObserverCleanupError) throw error; }
  return result;
}
