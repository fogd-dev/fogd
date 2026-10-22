// Fault injection runs in a disposable process, without production test hooks.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const unlink = fs.unlink;
fs.unlink = async path => {
  await unlink(path);
  if (path.includes('/build-trash/')) {
    process.send({ unlinked: true });
    await new Promise(resolve => process.once('message', resolve));
  }
};
syncBuiltinESMExports();
const { readBuildPlan, applyBuildPlan } = await import('../../src/build-cache/retention.mjs');
const [home, file, checksum, origin, snapshot] = process.argv.slice(2);
const plan = await readBuildPlan(file, checksum);
await applyBuildPlan(home, plan, origin, async () => JSON.parse(snapshot), checksum);
