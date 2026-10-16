import { fileURLToPath } from 'node:url';
import { cp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { stackRoot, run } from '../packages/cli/src/local.mjs';

export async function prepareGrowth(destination) {
  const project = join(stackRoot, 'examples/guestbook');
  await mkdir(destination, { recursive: false });
  const excluded = new Set(['node_modules', 'dist', '.void', '.wrangler', '.void-wrangler.jsonc', 'updates']);
  await cp(project, destination, { recursive: true, filter: path => !excluded.has(basename(path)) });
  await symlink(join(project, 'node_modules'), join(destination, 'node_modules'));
  const overlay = join(project, 'updates/attachments');
  for (const dir of ['routes', 'src', 'middleware']) await cp(join(overlay, dir), join(destination, dir), { recursive: true });
  const schema = join(destination, 'db/schema.ts');
  await writeFile(schema, await readFile(schema, 'utf8') + await readFile(join(overlay, 'schema.append.txt'), 'utf8'));
  const page = join(destination, 'pages/index.tsx');
  const source = await readFile(page, 'utf8');
  if (!source.includes('<h1>Guestbook</h1>')) throw new Error('Expected the checked-in guestbook fixture');
  await writeFile(page, "import Attachments from '../src/attachments';\n" + source.replace('</main>', '<Attachments messages={messages} /></main>'));
  const config = join(destination, 'tsconfig.json');
  const tsconfig = JSON.parse(await readFile(config, 'utf8')); tsconfig.include.push('src', 'middleware');
  await writeFile(config, JSON.stringify(tsconfig, null, 2));
  await run('pnpm', ['exec', 'void', 'db', 'generate'], { cwd: destination, env: { ...process.env, VOID_REMOTE: '0', WRANGLER_SEND_METRICS: 'false' } });
  await run('pnpm', ['run', 'typecheck'], { cwd: destination });
  return destination;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const destination = resolve(process.argv[2] || '.fogd/guestbook-growth');
  await mkdir(resolve(destination, '..'), { recursive: true });
  console.log(await prepareGrowth(destination));
}
