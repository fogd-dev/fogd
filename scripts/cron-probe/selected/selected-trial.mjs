import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { selectedHost, cleanupSelectedHost } from './host.mjs';
import { sourceInventory, sourceState } from './evidence.mjs';
import { scanOutputFiles } from './privacy.mjs';
import { checkedNativeDefaults, verifyNativeTimingEnvironment } from '../sealed/defaults.mjs';

export async function selectedTrial(output, scope, scenario) {
  const provenance = await sourceState(), sources = await sourceInventory(), source = await selectedHost(output);
  const installations = [source], evidence = {};
  const context = { source, installations, evidence, phase: 'source-fixtures' }; let failure;
  const save = (name, value) => writeFile(join(source.output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const heartbeat = setInterval(() => console.log(`waiting: ${context.phase}`), 20000); heartbeat.unref();
  try {
    await save('executed-source-inventory.json', { provenance, sources }); await cp(new URL(process.argv[1], `file://${process.cwd()}/`), join(source.output, 'runner.mjs'));
    for (const path of Object.keys(sources)) {
      const target = join(source.output, 'executed-source', path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await cp(path, target);
    }
    evidence.defaults = await checkedNativeDefaults();
    evidence.sourceTiming = await verifyNativeTimingEnvironment({ ...source, slots: source.policy.fleets.map(fleet => ({ nodes: fleet.nodes.map(node => node.host) })) });
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
