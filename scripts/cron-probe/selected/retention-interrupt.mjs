// Qualification-only process fault: stop after one real approved trash unlink.
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
const [home, file, checksum] = process.argv.slice(2);
process.env.FOGD_HOME = home;
const cli = new URL('../../../packages/cli/bin/fogd.js', import.meta.url);
process.argv = [process.execPath, cli.pathname, 'builds', 'prune', file, '--expected-plan', checksum];
await import(cli);
