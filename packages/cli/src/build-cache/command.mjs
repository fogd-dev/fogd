import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { appName } from '@fogd/runtime/artifact';
import { configEnv, serverOrigin, stackRoot } from '../local.mjs';
import { readAdminSnapshot } from '../inspect-command.mjs';
import { controllerOrigin, identity, digest } from './paths.mjs';
import { planBuilds, saveBuildPlan, readBuildPlan, applyBuildPlan, keepBuild, localBuilds, resumePrune } from './retention.mjs';

const usage = 'Usage: fogd builds plan APP --output FILE | prune FILE --expected-plan SHA | keep|unkeep APP BUILD_ID | list APP | resume APP BUILD_ID';
export async function buildsCommand(args) {
  const [action, ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { output: { type: 'string' }, 'expected-plan': { type: 'string' } } });
  if (action === 'list') {
    if (positionals.length !== 1 || Object.keys(values).length) throw new Error(usage);
    appName(positionals[0]); console.log(JSON.stringify(await localBuilds(stackRoot, positionals[0]), null, 2)); return;
  }
  if (action === 'resume') {
    if (positionals.length !== 2 || Object.keys(values).length) throw new Error(usage);
    identity(...positionals); console.log(JSON.stringify(await resumePrune(stackRoot, ...positionals), null, 2)); return;
  }
  if (['keep', 'unkeep'].includes(action)) {
    if (positionals.length !== 2 || Object.keys(values).length) throw new Error(usage);
    identity(...positionals);
    console.log(JSON.stringify(await keepBuild(stackRoot, ...positionals, action === 'keep'), null, 2)); return;
  }
  if (action === 'plan') return planCommand(positionals, values);
  return pruneCommand(action, positionals, values);
}
async function planCommand(positionals, values) {
  if (positionals.length !== 1 || !values.output || Object.keys(values).some(key => key !== 'output')) throw new Error(usage);
  appName(positionals[0]);
  const env = await configEnv(), origin = controllerOrigin(serverOrigin(env));
  const plan = await planBuilds(stackRoot, positionals[0], await readAdminSnapshot(env), origin);
  const file = resolve(values.output), sha256 = await saveBuildPlan(file, plan);
  console.log(JSON.stringify({ file, sha256, app: plan.app, reclaimableLogicalBytes: plan.reclaimableLogicalBytes,
    legacyEntriesKept: plan.legacyEntriesKept, unmanagedEntriesKept: plan.unmanagedEntriesKept,
    unfinishedPrunes: plan.unfinishedPrunes,
    builds: plan.rows.map(({ app, id, decision, reason, logicalBytes }) => ({ app, id, decision, reason, logicalBytes })) }, null, 2));
}
async function pruneCommand(action, positionals, values) {
  if (action !== 'prune' || positionals.length !== 1 || !digest(values['expected-plan']) || Object.keys(values).some(key => key !== 'expected-plan')) throw new Error(usage);
  const plan = await readBuildPlan(resolve(positionals[0]), values['expected-plan']);
  const env = await configEnv(), origin = controllerOrigin(serverOrigin(env));
  const result = await applyBuildPlan(stackRoot, plan, origin, () => readAdminSnapshot(env), values['expected-plan']);
  console.log(JSON.stringify(result, null, 2));
  if (result.results.some(row => row.refused)) process.exitCode = 1;
}
