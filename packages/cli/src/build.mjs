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
    enforce: 'post',
    configEnvironment(name, config) {
      if (name !== 'void_worker') return;
      // Pages adapters contribute a client entry through root build options.
      // celld's no_bundle upload needs only the Cloudflare worker entry here;
      // the separate client environment retains its own entries and splitting.
      config.build ??= {};
      const output = config.build.rolldownOptions?.output;
      if (Array.isArray(output)) throw new Error('fogd requires one void_worker output configuration');
      config.build.rolldownOptions = {
        ...config.build.rolldownOptions,
        input: { index: 'virtual:cloudflare/worker-entry' },
        output: { ...output, codeSplitting: false },
      };
    },
  }],
});
await builder.buildApp();
