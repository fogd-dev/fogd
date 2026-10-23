import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { execute } from '../../src/recovery/execute.mjs';

// The image runs Debian GNU tar; the host must provide GNU tar explicitly, by
// absolute path because the helper spawns tar with an empty environment.
export const gnuTar = ['gtar', 'tar'].map(command => {
  try { return execFileSync('/usr/bin/which', [command], { encoding: 'utf8' }).trim(); } catch { return null; }
}).find(path => path && execFileSync(path, ['--version'], { encoding: 'utf8' }).includes('GNU tar'));


export function durableDataTransport(config, policy, volumes, calls = []) {
  const byName = Object.fromEntries(Object.entries(volumes).map(([role, dir]) => [config.volumes[role].name, dir]));
  // Equivalent of volumeHelper: same fixed node helper code, with only the
  // container mount, tar and sync paths translated to the host.
  return async (image, volume, args, options) => {
    assert.equal(image, policy.image); assert.equal(options.entrypoint, '/usr/local/bin/node');
    assert.deepEqual(args.slice(0, 2), ['--input-type=module', '-e']); assert.equal(args.length, 4);
    const mode = args[3], writes = mode.startsWith('extract');
    assert.ok(['survey', 'extract', 'extract-controller', 'compare', 'compare-controller'].includes(mode));
    assert.equal(options.readonly, !writes);
    assert.deepEqual(options.capabilities, writes ? ['CHOWN', 'FOWNER', 'FSETID', 'DAC_OVERRIDE'] : ['DAC_OVERRIDE']);
    assert.equal(options.input === undefined, mode === 'survey'); assert.equal(options.maxOutputBytes, 4096);
    const role = Object.keys(volumes).find(name => volumes[name] === byName[volume]);
    calls.push([mode, role]);
    const code = args[2];
    for (const fixed of ["root='/data'", "tar='/bin/tar'", "sync='/bin/sync'"]) assert.ok(code.includes(fixed));
    const host = code.replace("root='/data'", `root=${JSON.stringify(byName[volume])}`).replace("tar='/bin/tar'", `tar=${JSON.stringify(gnuTar)}`);
    return execute(process.execPath, [...args.slice(0, 2), host, mode], { input: options.input, maxOutputBytes: options.maxOutputBytes });
  };
}
