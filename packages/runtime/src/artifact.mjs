import { readdir, readFile, writeFile, mkdir, lstat, cp } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const supported = new Set(['name', 'main', 'compatibility_date', 'compatibility_flags', 'vars', 'd1_databases', 'r2_buckets', 'durable_objects', 'migrations', 'assets', 'no_bundle']);
const generated = new Set(['$schema', 'configPath', 'userConfigPath', 'topLevelName', 'definedEnvironments', 'jsx_factory', 'jsx_fragment', 'exports', 'upload_source_maps', 'python_modules', 'dev', 'rules', 'observability', 'version_metadata']);
const flags = new Set(['nodejs_als', 'nodejs_compat', 'js_rpc', 'fetcher_no_get_put_delete', 'delete_all_deletes_alarm', 'websocket_standard_binary_type']);
const empty = value => value == null || value === false || value === '' || (typeof value === 'object' && Object.values(value).every(empty));
export function appName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) throw new Error('App name must be 1–63 lowercase letters, digits, or internal hyphens');
  return value;
}
export function inside(root, path) {
  const result = resolve(root, path);
  const rel = relative(resolve(root), result);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`Path escapes project: ${path}`);
  return result;
}
export function translateConfig(input, app) {
  appName(app);
  for (const [key, value] of Object.entries(input)) {
    if (!supported.has(key) && !generated.has(key) && !empty(value)) throw new Error(`Unsupported binding/config: ${key}`);
  }
  for (const flag of input.compatibility_flags || []) {
    if (!flags.has(flag)) throw new Error(`Unsupported compatibility flag: ${flag}`);
  }
  for (const [key, value] of Object.entries(input.vars || {})) {
    if (key.startsWith('__VOID_') || key.startsWith('__PROJECT_')) throw new Error(`Unsupported platform/auth variable: ${key}`);
    if (typeof value !== 'string') throw new Error(`celld requires string var: ${key}`);
  }
  for (const rule of input.rules || []) {
    if (rule.type !== 'ESModule') throw new Error(`Unsupported prebuilt module rule: ${rule.type}`);
  }
  const result = {
    name: app,
    main: 'worker/index.js',
    compatibility_date: input.compatibility_date,
    compatibility_flags: input.compatibility_flags || [],
    no_bundle: true,
    vars: input.vars || {},
    durable_objects: input.durable_objects || { bindings: [] },
    migrations: input.migrations || [],
    d1_databases: (input.d1_databases || []).map(binding => ({
      binding: binding.binding,
      database_name: `${app}-${binding.binding.toLowerCase()}`,
      database_id: `${app}-${binding.binding.toLowerCase()}`,
      migrations_dir: `migrations/${binding.binding}`,
    })),
    r2_buckets: (input.r2_buckets || []).map(binding => ({ binding: binding.binding, bucket_name: `${app}-${binding.binding.toLowerCase()}` })),
  };
  for (const binding of result.durable_objects.bindings || []) {
    if (binding.script_name) throw new Error('Cross-script Durable Objects are not supported');
  }
  if (input.assets) result.assets = { ...input.assets, directory: 'assets' };
  return result;
}
export function resourceIdentity(config) {
  return {
    script: config.name,
    d1: config.d1_databases,
    r2: config.r2_buckets,
    durable: config.durable_objects,
  };
}
async function regularFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in artifacts: ${path}`);
    if (entry.isDirectory()) files.push(...await regularFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unsupported artifact file: ${path}`);
  }
  return files.sort();
}
export async function artifactDigest(dir) {
  const hash = createHash('sha256');
  for (const path of await regularFiles(dir)) {
    if (path === 'fogd-release.json') continue;
    const data = await readFile(join(dir, path));
    hash.update(JSON.stringify([path, data.length])); hash.update(data);
  }
  return hash.digest('hex');
}
export async function stageArtifact({ projectDir, outputDir, app, buildOutput = 'dist/ssr', migrationsDir = 'db/migrations' }) {
  appName(app);
  const bundleDir = inside(projectDir, buildOutput);
  await regularFiles(bundleDir);
  const input = JSON.parse(await readFile(join(bundleDir, 'wrangler.json'), 'utf8'));
  const config = translateConfig(input, app);
  // The entry remains in its original module directory so relative chunk imports survive.
  config.main = `worker/${relative(bundleDir, inside(bundleDir, input.main))}`;
  await mkdir(outputDir, { recursive: false });
  await cp(bundleDir, join(outputDir, 'worker'), { recursive: true });
  if (input.assets) {
    const assets = inside(projectDir, resolve(bundleDir, input.assets.directory));
    await regularFiles(assets);
    await cp(assets, join(outputDir, 'assets'), { recursive: true });
  }
  if (config.d1_databases.length > 1) throw new Error('v0 supports one D1 database per app; multiple migration mappings need explicit support');
  for (const binding of config.d1_databases) {
    const source = inside(projectDir, migrationsDir);
    const entries = await readdir(source);
    const names = entries.filter(name => name.toLowerCase().endsWith('.sql') && name !== 'seed.sql').sort();
    let previous = -1n;
    const destination = join(outputDir, binding.migrations_dir);
    await mkdir(destination, { recursive: true });
    for (const name of names) {
      const match = /^(\d+)[_-]/.exec(name);
      if (!match || BigInt(match[1]) <= previous) throw new Error(`Migration order must have increasing numeric prefixes: ${name}`);
      previous = BigInt(match[1]);
      if (!(await lstat(join(source, name))).isFile()) throw new Error(`Migration is not a regular file: ${name}`);
      await cp(join(source, name), join(destination, name));
    }
  }
  await writeFile(join(outputDir, 'wrangler.json'), JSON.stringify(config, null, 2));
  const digest = await artifactDigest(outputDir);
  const release = { app, digest, resources: resourceIdentity(config) };
  await writeFile(join(outputDir, 'fogd-release.json'), JSON.stringify(release, null, 2));
  return release;
}
