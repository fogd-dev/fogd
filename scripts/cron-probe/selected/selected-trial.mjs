import { captureFailureLogs } from './failure-logs.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { selectedHost, cleanupSelectedHost } from './host.mjs';
import { archiveSources, sourceInventory, sourceState } from './evidence.mjs';
import { scanOutputFiles } from './privacy.mjs';
import { checkedNativeDefaults, verifyNativeTimingEnvironment } from '../sealed/defaults.mjs';

export function selectedTrial(output, scope, scenario, enrollment = 'candidate') {
  return selectedHostTrial(output, scope, async context => {
    const { source, evidence } = context;
    evidence.defaults = await checkedNativeDefaults();
    evidence.sourceTiming = await verifyNativeTimingEnvironment({ ...source, slots: source.policy.fleets.map(fleet => ({ nodes: fleet.nodes.map(node => node.host) })) });
    return scenario(context);
  }, enrollment);
}

export async function selectedHostTrial(output, scope, scenario, enrollment = 'public', hostOptions) {
  const provenance = await sourceState(), sources = await sourceInventory(), source = await selectedHost(output, enrollment, undefined, hostOptions);
  const installations = [source], evidence = {};
  const context = { source, installations, evidence, phase: 'source-fixtures' }; let failure;
  const save = (name, value) => writeFile(join(source.output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const heartbeat = setInterval(() => console.log(`waiting: ${context.phase}`), 20000); heartbeat.unref();
  try {
    await archiveSources(source.output, provenance, sources, new URL(process.argv[1], `file://${process.cwd()}/`));
    const fixture = await scenario(context);
    const receipt = { scope: scope, provenance, sources, family: source.entry.id, image: source.entry.image, sourcePolicy: source.policy, evidence };
    receipt.finalPrivacy = await scanOutputFiles(installations, fixture, receipt);
    assert.deepEqual(await sourceInventory(), sources); assert.deepEqual(await sourceState(), provenance);
    await save('result.json', receipt);
    const bytes = await readFile(join(source.output, 'result.json')), scan = await scanOutputFiles(installations, fixture, JSON.parse(bytes), [bytes]);
    await save('post-write-privacy.json', { sha256: createHash('sha256').update(bytes).digest('hex'), ...scan });
    console.log('PASS-selected-qualification');
  } catch (error) {
    failure = error;
    evidence.failureLogs = [];
    for (const host of installations.filter(host => !host.closed)) evidence.failureLogs.push({ project: host.project, ...await captureFailureLogs(host) });
    try { await save('failure.json', { phase: context.phase, name: error.name, message: error.message, cause: error.cause?.message, evidence }); }
    catch (recordError) { console.error('Could not retain failure record:', recordError.message); }
    throw error;
  } finally {
    clearInterval(heartbeat); const errors = [];
    for (const host of installations.filter(host => !host.closed).reverse()) {
      try { await cleanupSelectedHost(host); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], 'Selected qualification cleanup failed');
  }
}
