import { createBuilder } from 'vite';
import { resolve } from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('Usage: node scripts/build-app.mjs <app-directory>');
process.env.VOID_REMOTE = '0';
process.env.WRANGLER_SEND_METRICS = 'false';
process.chdir(resolve(root));
const builder = await createBuilder({
  root: process.cwd(),
  plugins: [{
    name: 'fogd-single-worker-module',
    configEnvironment(name) {
      if (name === 'void_worker') return { build: { rolldownOptions: { output: { codeSplitting: false } } } };
    },
  }],
});
await builder.buildApp();
