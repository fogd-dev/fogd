import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

process.chdir(resolve(process.argv[2] || '.'));
process.env.VOID_REMOTE = '0';
process.env.WRANGLER_SEND_METRICS = 'false';
const require = createRequire(resolve('package.json'));
const { createBuilder } = await import(pathToFileURL(require.resolve('vite')));
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
