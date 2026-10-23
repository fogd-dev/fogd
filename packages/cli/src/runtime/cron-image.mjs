import { isDeepStrictEqual } from 'node:util';
import { docker } from '../recovery/docker.mjs';

// No application volume, network, caller environment or image entrypoint is used.
// The image ID must come from an independently checked qualification policy.
export async function verifyCronRuntimeImage(profile, run = docker) {
  const code = `import {createHash} from 'node:crypto'; import {createReadStream, constants} from 'node:fs'; import {access, realpath} from 'node:fs/promises';
    for (const name of ['node', 'celld']) {
      let found; for (const directory of process.env.PATH.split(':')) { const path = directory + '/' + name; try { await access(path, constants.X_OK); found = await realpath(path); break; } catch {} }
      if (found !== '/usr/local/bin/' + name) throw new Error('Unexpected executable resolution');
    }
    const result = {}; for (const [key, file] of [['binarySha256', '/usr/local/bin/celld'], ['supervisorSha256', '/usr/local/bin/celld-supervisor']]) {
      if (await realpath(file) !== file) throw new Error('Runtime program must not be a symlink');
      const hash = createHash('sha256'); for await (const part of createReadStream(file)) hash.update(part); result[key] = hash.digest('hex');
    } console.log(JSON.stringify(result));`;
  try {
    profile = structuredClone(profile);
    if (!/^sha256:[a-f0-9]{64}$/.test(profile?.image || '') ||
      !['binarySha256', 'supervisorSha256'].every(key => /^[a-f0-9]{64}$/.test(profile[key] || ''))) throw new Error('Invalid preboot profile');
    const images = JSON.parse(await run(['image', 'inspect', profile.image], { timeoutMs: 15000 }));
    if ((profile.os && images[0]?.Os !== profile.os) || (profile.architecture && images[0]?.Architecture !== profile.architecture)) throw new Error('Runtime platform differs');
    assertImage(images, profile.image);
    const output = await runtimeInspector(profile.image, code, run);
    if (!isDeepStrictEqual(JSON.parse(output), { binarySha256: profile.binarySha256, supervisorSha256: profile.supervisorSha256 })) throw new Error('Runtime files differ');
  } catch { throw new Error('Scheduled runtime preboot verification failed; no application runtime was started'); }
}

export function runtimeInspector(image, code, run = docker) {
  return run(['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '128m', '--cpus', '1', '--pids-limit', '64', '--entrypoint', '/usr/local/bin/node',
    ...['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV'].flatMap(key => ['--env', `${key}=`]),
    image, '--input-type=module', '-e', code], { timeoutMs: 15000 });
}

function assertImage(images, expected) {
  const config = imageConfig(images, expected);
  if (!config || Object.keys(config.Volumes || {}).length || config.WorkingDir !== '/app' ||
    !['', '0', 'root'].includes(config.User || '') || (config.StopSignal && config.StopSignal !== 'SIGTERM')) throw new Error('Unsupported runtime image configuration');
  assertNoHealthcheck(config);
  assertImageEnvironment(config.Env || []);
}
function assertImageEnvironment(values) {
  if (new Set(values.map(value => value.split('=', 1)[0])).size !== values.length) throw new Error('Ambiguous inherited runtime environment');
  const env = Object.fromEntries(values.map(value => { const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)]; }));
  if (Object.keys(env).some(key => !['PATH', 'NODE_VERSION'].includes(key))) throw new Error('Unsupported runtime image environment');
  const paths = ['/opt/pnpm/node_modules/.bin', '/app/packages/runtime/node_modules/.bin', '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];
  if (!env.PATH || env.PATH.split(':').some(path => !paths.includes(path))) throw new Error('Runtime search path includes writable or unqualified locations');
}

export async function verifyCronStorageImage(image, run = docker) {
  try {
    if (!/^sha256:[a-f0-9]{64}$/.test(image || '')) throw new Error('Invalid storage image');
    const images = JSON.parse(await run(['image', 'inspect', image], { timeoutMs: 15000 }));
    assertStorageConfig(images, image);
  } catch { throw new Error('Scheduled storage image preboot verification failed; no application runtime was started'); }
}
function assertNoHealthcheck(config) {
  if (config.Healthcheck?.Test?.length && !isDeepStrictEqual(config.Healthcheck.Test, ['NONE'])) throw new Error('Unqualified image healthcheck');
}

function assertStorageConfig(images, expected) {
  const config = imageConfig(images, expected);
  if (!config || Object.keys(config.Volumes || {}).some(path => path !== '/data') || !['', '0', 'root'].includes(config.User || '')) throw new Error('Unsupported storage image');
  assertNoHealthcheck(config);
  const values = config.Env || [];
  if (values.length !== 1 || !values[0].startsWith('PATH=')) throw new Error('Unsupported inherited storage environment');
  if (values[0].slice(5).split(':').some(path => !['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'].includes(path))) throw new Error('Unsupported storage search path');
}

function imageConfig(images, expected) {
  if (!Array.isArray(images) || images.length !== 1 || images[0].Id !== expected || !images[0].Config) throw new Error('Image identity differs');
  return images[0].Config;
}
